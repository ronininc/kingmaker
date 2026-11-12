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
    // Observation caps. Defaults are the shipped values; scan.mjs may
    // override per run with extra script args of the form cap.<name>=<int>
    // (paths|sites|strings|decompile). Every cap, when hit, is accounted
    // in the coverage object (totals + omitted counts) — a capped export
    // is never indistinguishable from a complete one.
    private static int MAX_PATHS = 64;
    private static int MAX_SITES = 512;
    private static int MAX_STRINGS = 2000;
    private static int MAX_DECOMPILE = 24;

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

    private static String baseName(String n, String executableFormat) {
        if (n == null) return "";
        // Strip a trailing import-mangling suffix like "@GLIBC_2.2.5" or ordinal text.
        String s = n;
        int at = s.indexOf('@');
        if (at > 0) s = s.substring(0, at);
        // Mach-O's C ABI adds ONE underscore, including to names already
        // starting with one (_spawnv -> __spawnv). ELF/PE do not share this
        // rule: preserving their _spawn* and __isoc99_* names is essential.
        // Use the actual Ghidra loader name, not the host OS or filename.
        if ("Mac OS X Mach-O".equals(executableFormat) && s.startsWith("_") && s.length() > 1) {
            s = s.substring(1);
        }
        return s;
    }

    private String baseName(String n) {
        return baseName(n, currentProgram.getExecutableFormat());
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            printerr("ScriptureScan: missing output path argument");
            return;
        }
        String outPath = args[0];
        for (int i = 1; i < args.length; i++) {
            String a = args[i];
            if (!a.startsWith("cap.")) continue;
            int eq = a.indexOf('=');
            if (eq < 0) continue;
            try {
                int v = Integer.parseInt(a.substring(eq + 1).trim());
                if (v <= 0 || v > 1000000) continue;
                switch (a.substring(4, eq)) {
                    case "paths": MAX_PATHS = v; break;
                    case "sites": MAX_SITES = v; break;
                    case "strings": MAX_STRINGS = v; break;
                    case "decompile": MAX_DECOMPILE = v; break;
                    default: break;
                }
            } catch (NumberFormatException ignored) { }
        }
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
                .append("\",\"raw_name\":\"").append(esc(s.getName()))
                .append("\",\"library\":\"").append(esc(lib)).append("\"}");
        }

        // ---- entry points + input-touching functions ----
        Set<Function> roots = new HashSet<>();
        List<String> entryNames = new ArrayList<>();
        List<String> entryRawNames = new ArrayList<>();
        for (Symbol s : st.getAllSymbols(true)) {
            if (!s.isExternalEntryPoint()) continue;
            Function f = fm.getFunctionAt(s.getAddress());
            if (f != null) { roots.add(f); entryNames.add(baseName(f.getName())); entryRawNames.add(f.getName()); }
        }
        for (String n : new String[] {"main", "_start", "mainCRTStartup", "WinMain", "wmain", "entry"}) {
            Function f = byName.get(n);
            if (f != null && roots.add(f)) { entryNames.add(baseName(f.getName())); entryRawNames.add(f.getName()); }
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
        Map<String, List<Address>> sinkSites = new HashMap<>();
        int sitesTotal = 0;
        for (Function f : allFns) {
            String bn = baseName(f.getName());
            if (!SINKS.contains(bn)) continue;
            List<Reference> refs = new ArrayList<>();
            rm.getReferencesTo(f.getEntryPoint()).forEachRemaining(refs::add);
            for (Reference r : refs) {
                if (!r.getReferenceType().isCall()) continue;
                sitesTotal++;
                Function caller = fm.getFunctionContaining(r.getFromAddress());
                String callerRawName = caller != null ? caller.getName() : "(no-function)";
                String callerName = caller != null ? baseName(callerRawName) : callerRawName;
                if (siteJson.size() < MAX_SITES) siteJson.add("{\"func\":\"" + esc(callerName) + "\",\"func_raw\":\"" + esc(callerRawName)
                    + "\",\"callee\":\"" + esc(bn) + "\",\"callee_raw\":\"" + esc(f.getName())
                    + "\",\"addr\":\"" + esc(r.getFromAddress().toString()) + "\"}");
                if (caller != null) sinkSites.computeIfAbsent(caller.getEntryPoint() + "@" + bn, k -> new ArrayList<>()).add(r.getFromAddress());
            }
        }
        // ---- decompiler excerpts at exec/unbounded sink sites (capped) ----
        // Attempted/failed counts feed the confidence cap in scan.mjs.
        // BFS reachability with live objects: roots -> ... -> sink caller.
        int decAttempted = 0, decFailed = 0;
        List<String> decErrors = new ArrayList<>();
        Map<String, String> cByFunction = new HashMap<>();
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
                        List<Address> addresses = sinkSites.getOrDefault(cur.getEntryPoint() + "@" + cn, List.of());
                        if (addresses.isEmpty()) livePaths.add(new Object[] {root, cur, cn, callee.getName(), null});
                        for (Address address : addresses) livePaths.add(new Object[] {root, cur, cn, callee.getName(), address});
                    }
                    if (!parent.containsKey(callee)) { parent.put(callee, cur); q.add(callee); }
                }
            }
        }
        for (Object[] lp : livePaths) {
            Function caller = (Function) lp[1];
            String key = caller.getEntryPoint().toString();
            if (decompiledCallers.contains(key)) continue;
            if (decAttempted >= MAX_DECOMPILE) continue;
            decompiledCallers.add(key);
            decAttempted++;
            try {
                DecompileResults res = decomp.decompileFunction(caller, 30, monitor);
                if (res == null || res.getDecompiledFunction() == null) {
                    decFailed++;
                    String error = res == null ? decomp.getLastMessage() : res.getErrorMessage();
                    decErrors.add(error == null || error.isEmpty() ? "No decompiled function returned" : error);
                    continue;
                }
                String c = res.getDecompiledFunction().getC();
                if (c == null) { decFailed++; decErrors.add("Decompiler returned no C text"); continue; }
                cByFunction.put(key, c);
            } catch (Exception e) {
                decFailed++;
                decErrors.add(e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage()));
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
            String c = cByFunction.get(caller.getEntryPoint().toString());
            String excerpt = "";
            String lit = "null";
            String evidence = "unknown";
            // C text lacks stable instruction mapping. Only a unique textual AND actual
            // call can be paired; repeated calls remain unknown, never borrow the first.
            if (c != null) {
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?<![A-Za-z0-9_])" + (currentProgram.getExecutableFormat().contains("Mach-O") ? "_?" : "") + java.util.regex.Pattern.quote(sink) + "\\s*\\(").matcher(c);
                int idx = m.find() ? m.start() : -1;
                boolean unique = idx >= 0 && !m.find()
                    && sinkSites.getOrDefault(caller.getEntryPoint() + "@" + sink, List.of()).size() == 1;
                if (unique) {
                    excerpt = c.substring(Math.max(0, idx - 120), Math.min(c.length(), idx + 220)).replace('\n', ' ').trim();
                    // Only a single quoted first argument with no expression is a literal.
                    String tail = c.substring(c.indexOf('(', idx) + 1);
                    java.util.regex.Matcher arg = java.util.regex.Pattern.compile("^\\s*\"(?:[^\"\\\\]|\\\\.)*\"\\s*[,)]").matcher(tail);
                    lit = arg.find() ? "true" : "false";
                    evidence = "unique-call-text";
                }
            }
            enrichedPaths.add("{\"from\":{\"name\":\"" + esc(baseName(root.getName()))
                + "\",\"raw_name\":\"" + esc(root.getName())
                + "\",\"addr\":\"" + esc(root.getEntryPoint().toString())
                + "\"},\"via\":\"" + esc(baseName(caller.getName()))
                + "\",\"via_raw\":\"" + esc(caller.getName())
                + "\",\"sink\":\"" + esc(sink)
                + "\",\"sink_raw\":\"" + esc((String) lp[3])
                + "\",\"sink_addr\":\"" + esc(lp[4] == null ? "" : lp[4].toString())
                + "\",\"arg_literal\":" + lit
                + ",\"argument_evidence\":\"" + evidence + "\",\"sink_site\":{\"addr\":\"" + esc(lp[4] == null ? "" : lp[4].toString())
                + "\",\"excerpt\":\"" + esc(excerpt) + "\"}}");
        }

        // ---- strings (total counted even past the emission cap, so the
        // cap discloses itself in coverage instead of truncating silently) ----
        StringBuilder stringsJson = new StringBuilder();
        int sCount = 0;
        int sTotal = 0;
        Iterator<Data> di = currentProgram.getListing().getDefinedData(true);
        while (di.hasNext()) {
            Data d = di.next();
            if (!(d.getValue() instanceof String)) continue;
            try {
                StringDataInstance sdi = StringDataInstance.getStringDataInstance(d);
                if (sdi == null) continue;
                String v = sdi.getStringValue();
                if (v == null || v.isEmpty()) continue;
                sTotal++;
                if (sCount < MAX_STRINGS) {
                    if (sCount++ > 0) stringsJson.append(",");
                    stringsJson.append("{\"value\":\"").append(esc(v.length() > 300 ? v.substring(0, 300) : v))
                        .append("\",\"addr\":\"").append(esc(d.getAddress().toString())).append("\"}");
                }
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
        out.append(",\"entry_points_raw\":[");
        for (int i = 0; i < entryRawNames.size(); i++) {
            if (i > 0) out.append(",");
            out.append("\"").append(esc(entryRawNames.get(i))).append("\"");
        }
        out.append("]");
        out.append(",\"call_paths\":[").append(String.join(",", enrichedPaths)).append("]");
        out.append(",\"call_sites\":[").append(String.join(",", siteJson)).append("]");
        out.append(",\"strings\":[").append(stringsJson).append("]");
        out.append(",\"sections\":[").append(sectionsJson).append("]");
        out.append(",\"fid_matches\":[],\"fid_status\":\"not-performed\"");
        Set<String> eligibleFunctions = new HashSet<>();
        for (Object[] lp : livePaths) eligibleFunctions.add(((Function) lp[1]).getEntryPoint().toString());
        out.append(",\"coverage\":{\"paths_total\":").append(livePaths.size())
            .append(",\"paths_omitted\":").append(Math.max(0, livePaths.size() - enrichedPaths.size()))
            .append(",\"sites_total\":").append(sitesTotal).append(",\"sites_omitted\":").append(Math.max(0, sitesTotal - siteJson.size()))
            .append(",\"strings_total\":").append(sTotal).append(",\"strings_omitted\":").append(Math.max(0, sTotal - sCount))
            .append(",\"decompile_eligible\":").append(eligibleFunctions.size()).append(",\"decompile_omitted\":").append(Math.max(0, eligibleFunctions.size() - decAttempted)).append("}");
        out.append(",\"decompile\":{\"attempted\":").append(decAttempted)
            .append(",\"failed\":").append(decFailed).append(",\"errors\":[");
        for (int i = 0; i < decErrors.size(); i++) {
            if (i > 0) out.append(",");
            String error = decErrors.get(i);
            out.append("\"").append(esc(error.substring(0, Math.min(error.length(), 400)))).append("\"");
        }
        out.append("]}");
        out.append("}");
        try (FileWriter w = new FileWriter(outPath)) {
            w.write(out.toString());
        }
        println("ScriptureScan: observations written to " + outPath);
    }
}
