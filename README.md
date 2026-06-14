# pi-edge-tts

Microsoft Edge TTS integration for [pi](https://pi.dev) — voice output extension with text-to-speech.

## Install

```bash
pi install git:github.com/x2x5/pi-edge-tts
```

Or local:

```bash
pi install /path/to/pi-edge-tts
```

## Requirements

- Python package: `pip install edge-tts`

## Usage

Once installed, the extension provides:

### Commands

| Command | Description |
|---------|-------------|
| `/edge-tts` | Interactive config — choose voice, speed |
| `/edge-voices` | List available voices |
| `/edge-tts-on` | Enable TTS |
| `/edge-tts-off` | Disable TTS |

### Shortcut

| Key | Action |
|-----|--------|
| `Alt+V` | Toggle TTS on/off |

### Tool (for AI)

- `tts` — Convert text to speech audio. The AI can call this to read text aloud.

### Status Bar

The footer shows `♪ON` (green) when TTS is enabled, `♪OFF` (dim) when disabled.

## Configuration

Use `/edge-tts` to open the interactive config panel where you can:

- Toggle TTS on/off
- Choose voice (with filter/search)
- Adjust speech speed (0.5x — 2.0x)
- Preview voice samples
- Save defaults

Config is stored in `~/.pi/edge-tts/config.json`.
