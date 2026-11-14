# Model hosts

A model host is an Ollama server that holds and runs Kingmaker's models. This Mac's own Ollama is always one.
You can add others: a second Mac, a machine with a big GPU on your network, a machine reached through a tunnel.

These commands were written for Kingmaker. Several of the ideas come from looking at how `kimo`
(github.com/kimocoder/kimo, GPL-3.0) handles the same jobs; none of its code is used here.

## Commands

    kingmaker models hosts                                  every host: answering, version, what it holds
    kingmaker models hosts add studio 192.168.1.20:11434    add one (--key-env NAME if it needs a key)
    kingmaker models hosts remove studio
    kingmaker models ps [--host studio]                     what is loaded, and whether Kingmaker loaded it
    kingmaker models warm <model> [24h] [--host studio]     load a model and hold it
    kingmaker models stop <model|all> [--host studio]       unload
    kingmaker models sync <model> --to studio               copy a model to another host
    kingmaker models speed <model> [--runs 5] [--warmup]    how fast it really is
    kingmaker doctor                                        now includes every host and a scorecard

## Copying a model to another machine (`sync`)

The two hosts are compared by the digest each one lists for the model.

**From this Mac, the copy is exact.** The model's files are read from this Mac's Ollama folder. Each one is
uploaded under its SHA-256 name; the other machine checks the bytes against that name and refuses a mismatch.
The other machine then builds the model from those files. Afterwards every file is asked for again by its
SHA-256 and the model must be in the listing, or the copy is reported as failed. A file that is already there is
not uploaded twice.

The digest the other machine *lists* for the model will usually differ from this Mac's, because it writes its own
manifest. The command says so. The weights are the same bytes; that is what was checked.

**From another machine, it cannot be exact from here.** That machine's files cannot be read from this Mac, so the
destination is asked to download the model by name instead. If the two listings then show the same digest, it is
the same model. If not, the command says they are different builds and that the exact copy has to be run on the
machine that has the model.

A model's stored example messages go across with it. A model that carries an adapter file, or any part this
code does not recognise, is not rebuilt (an exact rebuild would leave that part out); it is downloaded by name and
reported that way.

`--dry-run` shows what would be copied. `--all` does every model the source has; with neither a model nor
`--all` the command copies nothing and says so. `--force` copies even when both
already list the same digest.

## Keeping a model loaded (`warm`, `stop`)

Ollama makes room for a new model by unloading whichever loaded model was used least recently. On a machine
other people or other programs share, that would unload someone else's model without a word.

- Kingmaker remembers which models it loaded on each host.
- `warm` first works out whether the model fits beside what is loaded. If it fits, it loads.
- "Fits" uses what the model was **seen to take once loaded on that host**, which Kingmaker records after each
  load. The size of the model's file is not that figure: a loaded model also holds its working memory, so the
  file size can show that a model does *not* fit, never that it does. The first time a model is warmed on a host
  with other models loaded, the command therefore asks.
- If it does not fit, nothing is unloaded. The command lists what would have to go and stops. `--evict` allows
  it, and then Kingmaker's own models go before anyone else's. In a terminal it asks instead.
- For another machine the memory limit is not known, so "does it fit" cannot be answered. With other models
  loaded there, the command asks rather than assumes. `KINGMAKER_MODEL_BUDGET_GB=24` gives it the figure.
- `stop all` unloads what Kingmaker loaded. Other models stay unless `--everyone` is given. The pinned reflex
  model stays unless it is named.

## Speed (`speed`)

This measures one model on one host. It does not replace `kingmaker models bench`, which decides which model
fills which role on each class of Mac.

- **Cold and warm are reported apart.** The first run on a model that was not loaded pays for loading it. That
  run is shown by itself and left out of the typical figures.
- **No help from the cache.** Each run gets a prompt whose first line no other run used, so each one reads its
  whole prompt.
- **Typical, with the range.** The headline is the median of the warm runs, with the lowest and highest beside it.
  One warm run is called one run.
- `--warmup` loads the model first, untimed. `--json` prints everything for a script.

Time to first token is timed on this side. Token rates come from the host's own counters.

## Keys

- A host is sent only the key set up for that host. `--key-env NAME` stores the **name** of the environment
  variable that holds it. The key itself is never written to disk.
- Your provider keys (OpenAI, Anthropic, Hugging Face, GitHub and the rest of the list in
  `lib/model-hosts.mjs`) are never sent to a model host. Naming one as a host's key is refused, and so is a
  host key that has the same value as one of them.
- A key is not sent over plain http across the internet. It is sent over https, or over plain http only to this
  Mac or your own network.
- "Your own network" means a real private address (such as `192.168.1.20`) or a name only a local network
  answers for (`studio.local`). A public name that merely starts like one (`10.models.example.com`) is treated
  as the internet.

These rules apply to the commands on this page. The rest of Kingmaker talks only to this Mac's Ollama and sends
it no key.

## "unavailable"

A figure that could not be read or timed is printed as `unavailable (why)`, and in `--json` as
`{ "unavailable": true, "reason": "..." }`. No command here prints a zero or a guess in its place.

## What has not been checked

Everything above is tested against stand-in Ollama servers that follow the documented API, including refusing an
upload whose bytes do not match its SHA-256. None of it has been run against a real Ollama, because the machine
this was built on has none. Before relying on it, on your Mac:

    cd <the Kingmaker checkout>
    node --test test/model-hosts.test.mjs
    kingmaker models hosts
    kingmaker models speed <a model you have> --runs 3

The exact-copy path depends on Ollama's blob and create requests behaving as documented on the version you run.
