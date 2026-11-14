// ScriptureScan.java — Scripture Armor v2 Closure 1: the DUMB EXPORTER.
//
// Runs inside Ghidra headless (analyzeHeadless -postScript) and writes ONE
// JSON document of RAW OBSERVATIONS about the imported program: imports,
// functions, memory blocks, strings, direct call sites, call-graph paths
// from entry/input-touching functions to known sink functions, and capped
// decompiler excerpts at sink call sites. It applies NO rules, NO
// severities, NO verdicts — all judgment lives in scan.mjs (scan-rules/1),
// one auditable policy surface. Pattern: CERT Kaiju / SaTC ref2sink —
// enumerate sinks, walk reachability, excerpt the sink sites.
//
// Usage: -postScript "ScriptureScan.java <absolute-path-to-observations.json>"
//
// @category Scripture Armor

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolTable;

import java.io.FileWriter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class ScriptureScan extends GhidraScript {

    // Sink + input function name tables. These are FACT tables (which
    // functions exist), not judgments — scan.mjs decides what they mean.
    private static final Set<String> SINKS = new HashSet<>(Set.of(
        "system", "popen", "execl", "execlp", "execle", "execv", "execve", "execvp", "execvpe",
        "WinExec", "ShellExecute", "ShellExecuteEx", "CreateProcess", "CreateProcessA", "CreateProcessW",
        "_spawnl", "_spawnlp", "_spawnv", "_spawnvp",
        "strcpy", "strcat", "gets", "sprintf", "vsprintf", "stpcpy", "wcscpy", "wcscat",
        "CreateRemoteThread", "VirtualAllocEx", "WriteProcessMemory"));
    private static final Set<String> INPUT_FNS = new HashSet<>(Set.of(
        "recv", "recvfrom", "read", "fread", "fgets", "scanf", "fscanf", "sscanf",
        "getenv", "getopt", "getopt_long", "accept", "InternetReadFile", "getline", "__isoc99_scanf"));
    private static final int MAX_PATHS = 64;
    private static final int MAX_SITES = 512;
    private static final int MAX_STRINGS = 2000;
    private static final int MAX_DECOMPILE = 24;

    private static String esc(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.toString();
    }

    private static String baseName(String n) {
        if (n == null) return "";
        int i = n.lastIndexOf('.');
        // Strip a trailing import-mangling suffix like "@GLIBC_2.2.5" or ordinal text.
        String s = n;
        int at = s.indexOf('@');
        if (at > 0) s = s.substring(0, at);
        return s;
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            printerr("ScriptureScan: missing output path argument");
            return;
        }
        String outPath = args[0];
        FunctionManager fm = currentProgram.getFunctionManager();
        SymbolTable st = currentProgram.getSymbolTable();
        ReferenceManager rm = currentProgram.getReferenceManager();

        // ---- functions, adjacency (caller -> callees), reverse index ----
        Map<String, Function> byName = new HashMap<>();
        Map<Function, Set<Function>> calls = new HashMap<>();
        Map<Function, Set<Function>> calledBy = new HashMap<>();
        List<Function> allFns = new ArrayList<>();
        FunctionIterator fit = fm.getFunctions(true);
        while (fit.hasNext()) {
            Function f = fit.next();
            allFns.add(f);
            byName.putIfAbsent(baseName(f.getName()), f);
        }
        for (Function f : allFns) {
            Set<Function> out = new HashSet<>();
            try {
                for (Function callee : f.getCalledFunctions(monitor)) {
                    out.add(callee);
                    calledBy.computeIfAbsent(callee, k -> new HashSet<>()).add(f);
                }
            } catch (Exception ignored) { }
            calls.put(f, out);
        }

        // ---- imports (external symbols) ----
        StringBuilder importsJson = new StringBuilder();
        int importCount = 0;
        for (Symbol s : st.getExternalSymbols()) {
            if (importCount++ > 0) importsJson.append(",");
            String lib = "";
            try {
                if (s.getParentNamespace() != null) lib = s.getParentNamespace().getName();
            } catch (Exception ignored) { }
            importsJson.append("{\"name\":\"").append(esc(baseName(s.getName())))
                .append("\",\"library\":\"").append(esc(lib)).append("\"}");
        }

        // ---- entry points + input-touching functions ----
        Set<Function> roots = new HashSet<>();
        List<String> entryNames = new ArrayList<>();
        for (Symbol s : st.getAllSymbols(true)) {
            if (!s.isExternalEntryPoint()) continue;
            Function f = fm.getFunctionAt(s.getAddress());
            if (f != null) { roots.add(f); entryNames.add(f.getName()); }
        }
        for (String n : new String[] {"main", "_start", "mainCRTStartup", "WinMain", "wmain", "entry"}) {
            Function f = byName.get(n);
            if (f != null && roots.add(f)) entryNames.add(n);
        }
        // Functions nobody calls are candidate entry surfaces too.
        for (Function f : allFns) {
            Set<Function> callers = calledBy.get(f);
            if ((callers == null || callers.isEmpty()) && !f.isThunk()) roots.add(f);
        }
        Set<Function> inputTouching = new HashSet<>(roots);
        for (Function f : allFns) {
            for (Function callee : calls.getOrDefault(f, Set.of())) {
                if (INPUT_FNS.contains(baseName(callee.getName()))) { inputTouching.add(f); break; }
            }
        }

        // ---- BFS from each root over the call graph to sink functions ----
        // Records the SHORTEST root for each (sink, sink-site) pair found.
        List<String> siteJson = new ArrayList<>();
        // Direct call sites: for every sink function, its calling references.
        Map<String, Address> sinkSiteAddr = new HashMap<>();
        for (Function f : allFns) {
            String bn = baseName(f.getName());
            if (!SINKS.contains(bn)) continue;
            List<Reference> refs = new ArrayList<>();
            rm.getReferencesTo(f.getEntryPoint()).forEachRemaining(refs::add);
            for (Reference r : refs) {
                if (siteJson.size() >= MAX_SITES) break;
                Function caller = fm.getFunctionContaining(r.getFromAddress());
                String callerName = caller != null ? caller.getName() : "(no-function)";
                siteJson.add("{\"func\":\"" + esc(callerName) + "\",\"callee\":\"" + esc(bn)
                    + "\",\"addr\":\"" + esc(r.getFromAddress().toString()) + "\"}");
                sinkSiteAddr.put(bn + "@" + r.getFromAddress(), r.getFromAddress());
            }
        }
        // ---- decompiler excerpts at exec/unbounded sink sites (capped) ----
        // Attempted/failed counts feed the confidence cap in scan.mjs.
        // BFS reachability with live objects: roots -> ... -> sink caller.
        int decAttempted = 0, decFailed = 0;
        Map<String, String> excerptBySinkCaller = new HashMap<>();
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(currentProgram);
        Set<String> decompiledCallers = new HashSet<>();
        List<Object[]> livePaths = new ArrayList<>();
        for (Function root : roots) {
            Map<Function, Function> parent = new HashMap<>();
            ArrayDeque<Function> q = new ArrayDeque<>();
            q.add(root); parent.put(root, null);
            while (!q.isEmpty()) {
                Function cur = q.poll();
                for (Function callee : calls.getOrDefault(cur, Set.of())) {
                    String cn = baseName(callee.getName());
                    // A path is only real when a genuine function body calls
                    // the sink. The sink's own PLT thunk "calling" the
                    // external symbol is loader plumbing, not a call path —
                    // decompiling it yields garbage literalness verdicts.
                    if (SINKS.contains(cn) && inputTouching.contains(root)
                            && !cur.isThunk() && !baseName(cur.getName()).equals(cn)) {
                        livePaths.add(new Object[] {root, cur, cn});
                    }
                    if (!parent.containsKey(callee)) { parent.put(callee, cur); q.add(callee); }
                }
            }
        }
        for (Object[] lp : livePaths) {
            Function caller = (Function) lp[1];
            String sink = (String) lp[2];
            String key = sink + "@" + caller.getName();
            if (excerptBySinkCaller.containsKey(key) || decompiledCallers.contains(caller.getName())) continue;
            if (decAttempted >= MAX_DECOMPILE) break;
            decompiledCallers.add(caller.getName());
            decAttempted++;
            try {
                DecompileResults res = decomp.decompileFunction(caller, 30, monitor);
                if (res == null || res.getDecompiledFunction() == null) { decFailed++; continue; }
                String c = res.getDecompiledFunction().getC();
                if (c == null) { decFailed++; continue; }
                int idx = c.indexOf(sink + "(");
                if (idx < 0) idx = Math.max(0, c.length() / 2);
                int lo = Math.max(0, idx - 120);
                int hi = Math.min(c.length(), idx + 220);
                String excerpt = c.substring(lo, hi).replace('\n', ' ').trim();
                excerptBySinkCaller.put(key, excerpt);
                // Argument literalness: text between the sink's parens.
                boolean literal = false;
                int p = c.indexOf('(', idx);
                if (p >= 0) {
                    int depth = 0, end = -1;
                    for (int i = p; i < c.length() && i < p + 300; i++) {
                        char ch = c.charAt(i);
                        if (ch == '(') depth++;
                        if (ch == ')') { depth--; if (depth == 0) { end = i; break; } }
                    }
                    if (end > p) {
                        String arg = c.substring(p + 1, end).trim();
                        literal = arg.matches("^\"[^\"]*\"$") || arg.matches("^\\d+$")
                            || arg.matches("^0x[0-9a-fA-F]+$") || arg.equals("NULL")
                            || arg.matches("^\".*\"$");
                    }
                }
                excerptBySinkCaller.put(key + "#literal", String.valueOf(literal));
            } catch (Exception e) {
                decFailed++;
            }
        }
        decomp.dispose();
        // Enrich path JSON with excerpt + literalness.
        List<String> enrichedPaths = new ArrayList<>();
        for (Object[] lp : livePaths) {
            if (enrichedPaths.size() >= MAX_PATHS) break;
            Function root = (Function) lp[0];
            Function caller = (Function) lp[1];
            String sink = (String) lp[2];
            String key = sink + "@" + caller.getName();
            String excerpt = excerptBySinkCaller.getOrDefault(key, "");
            String lit = excerptBySinkCaller.getOrDefault(key + "#literal", "false");
            enrichedPaths.add("{\"from\":{\"name\":\"" + esc(root.getName())
                + "\",\"addr\":\"" + esc(root.getEntryPoint().toString())
                + "\"},\"via\":\"" + esc(caller.getName())
                + "\",\"sink\":\"" + esc(sink)
                + "\",\"sink_addr\":\"" + esc(caller.getEntryPoint().toString())
                + "\",\"arg_literal\":" + lit
                + ",\"sink_site\":{\"addr\":\"" + esc(caller.getEntryPoint().toString())
                + "\",\"excerpt\":\"" + esc(excerpt) + "\"}}");
        }

        // ---- strings ----
        StringBuilder stringsJson = new StringBuilder();
        int sCount = 0;
        Iterator<Data> di = currentProgram.getListing().getDefinedData(true);
        while (di.hasNext() && sCount < MAX_STRINGS) {
            Data d = di.next();
            if (!(d.getValue() instanceof String)) continue;
            try {
                StringDataInstance sdi = StringDataInstance.getStringDataInstance(d);
                if (sdi == null) continue;
                String v = sdi.getStringValue();
                if (v == null || v.isEmpty()) continue;
                if (sCount++ > 0) stringsJson.append(",");
                stringsJson.append("{\"value\":\"").append(esc(v.length() > 300 ? v.substring(0, 300) : v))
                    .append("\",\"addr\":\"").append(esc(d.getAddress().toString())).append("\"}");
            } catch (Exception ignored) { }
        }

        // ---- memory blocks (sections) with sampled entropy ----
        StringBuilder sectionsJson = new StringBuilder();
        int bCount = 0;
        for (MemoryBlock blk : currentProgram.getMemory().getBlocks()) {
            double entropy = 0.0;
            try {
                long size = Math.min(blk.getSize(), 262144);
                if (size > 0 && blk.isInitialized()) {
                    byte[] bytes = new byte[(int) size];
                    blk.getBytes(blk.getStart(), bytes);
                    long[] freq = new long[256];
                    for (byte bb : bytes) freq[bb & 0xff]++;
                    for (long f : freq) {
                        if (f == 0) continue;
                        double p = (double) f / bytes.length;
                        entropy -= p * (Math.log(p) / Math.log(2));
                    }
                }
            } catch (Exception ignored) { }
            if (bCount++ > 0) sectionsJson.append(",");
            sectionsJson.append("{\"name\":\"").append(esc(blk.getName()))
                .append("\",\"size\":").append(blk.getSize())
                .append(",\"exec\":").append(blk.isExecute())
                .append(",\"entropy\":").append(String.format(java.util.Locale.ROOT, "%.3f", entropy))
                .append("}");
        }

        StringBuilder out = new StringBuilder();
        out.append("{\"format\":\"scripture-scan-obs/1\"");
        out.append(",\"loader\":\"").append(esc(currentProgram.getExecutableFormat())).append("\"");
        out.append(",\"imports\":[").append(importsJson).append("]");
        out.append(",\"functions_count\":").append(allFns.size());
        out.append(",\"entry_points\":[");
        for (int i = 0; i < entryNames.size(); i++) {
            if (i > 0) out.append(",");
            out.append("\"").append(esc(entryNames.get(i))).append("\"");
        }
        out.append("]");
        out.append(",\"call_paths\":[").append(String.join(",", enrichedPaths)).append("]");
        out.append(",\"call_sites\":[").append(String.join(",", siteJson)).append("]");
        out.append(",\"strings\":[").append(stringsJson).append("]");
        out.append(",\"sections\":[").append(sectionsJson).append("]");
        out.append(",\"fid_matches\":[]");
        out.append(",\"decompile\":{\"attempted\":").append(decAttempted)
            .append(",\"failed\":").append(decFailed).append("}");
        out.append("}");
        try (FileWriter w = new FileWriter(outPath)) {
            w.write(out.toString());
        }
        println("ScriptureScan: observations written to " + outPath);
    }
}
