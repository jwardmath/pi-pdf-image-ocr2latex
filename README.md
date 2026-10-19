# pi-pdf-image-ocr2latex

Two Pi extensions for turning images/PDFs into compiled LaTeX documents:

- **`/img2tikz`** — converts an image or PDF into a `.tikz.tex` file using a **pluggable vision model**, then compiles it to a `.pdf` with `pdflatex`.
- **`/latexcompile`** — compiles a `.tex` file with `pdflatex`, auto-fixing common errors so the document compiles.

---

## Install

```bash
pi install git:github.com/jwardmath/pi-pdf-image-ocr2latex@v1
```

Then restart Pi (or run `/reload`). Try without installing:

```bash
pi -e git:github.com/jwardmath/pi-pdf-image-ocr2latex
```

---

## Prerequisites

### 1. A vision model (for `/img2tikz`)

By default `/img2tikz` uses **Ollama** with the **`qwen2.5vl:7b`** model:

```bash
# 1. Install Ollama:  https://ollama.com
# 2. Pull the vision model
ollama pull qwen2.5vl:7b
```

#### Local configuration (recommended)

The model and provider are stored in a **local config file**, so you don't need to pass flags or environment variables every time.

Create `~/.pi/agent/image2tikz.json`:

```json
{
  "provider": "ollama",
  "model": "qwen2.5vl:7b",
  "swapModel": false
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `provider` | string | `ollama` | Pi provider id for the vision model |
| `model` | string | `qwen2.5vl:7b` | Vision model id |
| `swapModel` | boolean | `false` | Also switch the session's active model during a run (restored afterward) |

#### Configuration precedence

Higher beats lower:

1. **CLI flags** — `/img2tikz foo.png --provider X --model Y --swap-model`
2. **Config file** — `~/.pi/agent/image2tikz.json`
3. **Environment variables** — `PI_IMG2TIKZ_PROVIDER`, `PI_IMG2TIKZ_MODEL`
4. **Built-in defaults** — `ollama` / `qwen2.5vl:7b`

> Override the config-file location with `PI_IMG2TIKZ_CONFIG=/path/to/config.json` (absolute, or relative to the agent directory).

Example for a hosted model on OpenRouter (provider must be configured in Pi via `/login` or `models.json`):

```json
{
  "provider": "openrouter",
  "model": "qwen/qwen2.5-vl-72b-instruct",
  "swapModel": false
}
```

Any vision-capable model on a configured provider works — no code changes needed.

> **Note:** `provider`/`model` affect only the vision call itself. To also make the follow-up turn use the vision model, set `"swapModel": true` (or pass `--swap-model`).

### 2. A LaTeX engine (for `/latexcompile` and PDF output)

Install a TeX distribution and make sure `pdflatex` is on your `PATH`:

| OS | Install |
|---|---|
| Windows | [MiKTeX](https://miktex.org) |
| macOS | [MacTeX](https://tug.org/mactex) / `brew install --cask mactex` |
| Linux | `sudo apt install texlive-latex-recommended` (or full TeX Live) |

---

## Usage

### `/img2tikz`

```bash
/img2tikz path/to/diagram.png
/img2tikz path/to/report.pdf --pages 1-5 --scale 2
/img2tikz .                       # process all images/PDFs in a directory
/img2tikz a.png b.pdf             # multiple inputs
```

Options:

| Flag | Default | Description |
|---|---|---|
| `--model` | `qwen2.5vl:7b` (config file) | Vision model id |
| `--provider` | `ollama` (config file) | Provider id |
| `--scale` | `2` | Rasterization scale for PDF pages |
| `--dpi` | `150` | PDF rasterization DPI |
| `--pages` | all | Page range, e.g. `1-5,7` |
| `--out` | next to input | Output directory |
| `--multiple` | `false` | One `.tex` per PDF page |
| `--keep-images` | `false` | Keep rasterized page images |
| `--swap-model` | `false` | Also switch the session's active model during the run |

Output is written as `<basename>.tikz.tex` next to each input, then compiled to `<basename>.tikz.pdf` in the same directory.

### `/latexcompile`

```bash
/latexcompile main.tex
```

Compiles with `pdflatex` (non-interactive), re-runs up to 5 passes to resolve cross-references, auto-fixes missing files / undefined control sequences / undefined environments directly in the `.tex` source, mitigates overfull/underfull hboxes, and opens the PDF on success.

---

## How it works (model routing)

The vision call uses Pi's model registry, so it works with **any** provider Pi knows about — Ollama, OpenRouter, Anthropic, OpenAI-compatible endpoints, etc. Configuration is stored in `~/.pi/agent/image2tikz.json` (see above); CLI flags and environment variables are optional one-off overrides. No code changes are needed to point at a different vision backend.

## License

MIT
