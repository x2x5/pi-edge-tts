/**
 * Edge TTS — Microsoft Edge TTS integration for pi.
 *
 * Uses the edge-tts Python package (pip install edge-tts).
 *
 * Commands:
 *   /edge-tts      Interactive voice/speed config
 *   /edge-voices   List available voices
 *   /edge-tts-on   Enable TTS
 *   /edge-tts-off  Disable TTS
 *
 * Shortcuts:
 *   Alt+V          Toggle TTS on/off
 *
 * Tool (LLM):
 *   tts            Convert text to speech
 */

import { exec, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const execAsync = promisify(exec);

// ── Types ──

interface Config {
  enabled: boolean;
  voice: string;
  speed: number;
  pitch: number;
}

interface SessionState {
  enabled?: boolean;
  voice?: string;
  speed?: number;
}

// ── Constants ──

const CONFIG_DIR = resolve(homedir(), ".pi", "edge-tts");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const WAV_DIR = join(CONFIG_DIR, "audio");

const DEFAULT_CONFIG: Config = {
  enabled: true,
  voice: "zh-CN-XiaoxiaoNeural",
  speed: 1.0,
  pitch: 0,
};

const SPEED_VALUES = [
  "0.5", "0.75", "1.0", "1.25", "1.5", "1.75", "2.0",
];

// ── Config Helpers ──

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return {
        enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
        voice: raw.voice ?? DEFAULT_CONFIG.voice,
        speed: raw.speed ?? DEFAULT_CONFIG.speed,
        pitch: raw.pitch ?? DEFAULT_CONFIG.pitch,
      };
    }
  } catch {
    /* use defaults */
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: Config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function getEffective(defaults: Config, session: SessionState): Config {
  return {
    enabled: session.enabled ?? defaults.enabled,
    voice: session.voice ?? defaults.voice,
    speed: session.speed ?? defaults.speed,
    pitch: defaults.pitch,
  };
}

function speedToIndex(speed: number): number {
  const idx = SPEED_VALUES.findIndex((s) => Number.parseFloat(s) === speed);
  return idx >= 0 ? idx : 2; // default to index of 1.0
}

// ── Voices cache ──

let _cachedVoices: Array<{ name: string; gender: string; categories: string; personality: string }> | null = null;

function parseVoices(output: string) {
  const lines = output.trim().split("\n");
  // Skip header line
  const voices: Array<{ name: string; gender: string; categories: string; personality: string }> = [];
  for (const line of lines) {
    // Format: Name  Gender  ContentCategories  VoicePersonalities
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 4) continue;
    const name = parts[0]?.trim() ?? "";
    if (!name || name === "Name") continue;
    voices.push({
      name,
      gender: parts[1]?.trim() ?? "",
      categories: parts[2]?.trim() ?? "",
      personality: parts[3]?.trim() ?? "",
    });
  }
  return voices;
}

function getVoices() {
  if (_cachedVoices) return _cachedVoices;
  try {
    const output = execSync("edge-tts --list-voices", {
      encoding: "utf-8",
      timeout: 15000,
    });
    _cachedVoices = parseVoices(output);
  } catch {
    _cachedVoices = [];
  }
  return _cachedVoices;
}

function buildVoiceOptions(voices: Array<{ name: string; gender: string; categories: string; personality: string }>): string[] {
  return voices.map((v) => v.name);
}

// ── TTS Engine ──

function buildEdgeArgs(config: Config): string {
  const rate = Math.round((config.speed - 1.0) * 100);
  const rateStr = rate >= 0 ? `+${rate}%` : `${rate}%`;
  const pitchStr = config.pitch >= 0 ? `+${config.pitch}Hz` : `${config.pitch}Hz`;
  return `--rate=${rateStr} --pitch=${pitchStr}`;
}

async function speak(text: string, config: Config): Promise<string> {
  mkdirSync(WAV_DIR, { recursive: true });
  const outPath = join(WAV_DIR, `tts-${Date.now()}.mp3`);
  const textFile = join(WAV_DIR, `tts-${Date.now()}.txt`);

  // Write text to temp file to avoid shell escaping issues
  writeFileSync(textFile, text, "utf-8");

  const edgeArgs = buildEdgeArgs(config);
  const cmd = `edge-tts --voice "${config.voice}" ${edgeArgs} -f "${textFile}" --write-media "${outPath}"`;

  await execAsync(cmd, { timeout: 60000 });

  // Clean up temp text file
  try { unlinkSync(textFile); } catch { /* ignore */ }

  // Play it (macOS afplay, Linux aplay/paplay)
  const player = process.platform === "darwin" ? "afplay" : "paplay";
  // Add 500ms silence at start to prevent afplay cutting off the beginning
  const paddedPath = join(WAV_DIR, `tts-${Date.now()}-pad.mp3`);
  await execAsync(`ffmpeg -y -i "${outPath}" -af "adelay=500|500" "${paddedPath}"`, { timeout: 30000 });
  await execAsync(`${player} "${paddedPath}"`, { timeout: 60000 });
  try { unlinkSync(paddedPath); } catch { /* ignore */ }

  // Clean up after playback
  try { unlinkSync(outPath); } catch { /* ignore */ }

  return outPath;
}

// ── Extension ──

export default function (pi: ExtensionAPI) {
  let defaults = loadConfig();
  let session: SessionState = {};
  let currentCtx: ExtensionContext | undefined;

  function getConf(): Config {
    return getEffective(defaults, session);
  }

  function persistSession() {
    pi.appendEntry<SessionState>("edge-tts-state", { ...session });
  }

  function restoreSession(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "edge-tts-state") {
        const data = entry.data as SessionState | undefined;
        if (data) session = { ...data };
      }
    }
    defaults = loadConfig();
  }

  // ── Status bar ──

  function updateStatus() {
    if (!currentCtx) return;
    const conf = getConf();
    const theme = currentCtx.ui.theme;
    if (conf.enabled) {
      currentCtx.ui.setStatus("tts", theme.fg("success", "♪ON"));
    } else {
      currentCtx.ui.setStatus("tts", theme.fg("dim", "♪OFF"));
    }
  }

  // ── Audio queue (serialize playback) ──

  const queue: Array<() => Promise<void>> = [];
  let playing = false;

  function enqueue(fn: () => Promise<void>) {
    queue.push(fn);
    if (!playing) drain();
  }

  function drain() {
    if (playing || queue.length === 0) return;
    playing = true;
    const item = queue.shift()!;
    item().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[edge-tts] speak error:", msg.split("\n")[0]);
    }).finally(() => {
      playing = false;
      drain();
    });
  }

  // ── tts tool (replace any existing one) ──

  pi.registerTool({
    name: "tts",
    label: "Text to Speech",
    description:
      "Convert text to speech audio using Microsoft Edge TTS. Saves an MP3 file and plays it.",
    promptSnippet: "Convert text to speech and play audio",
    promptGuidelines: [
      "Use tts when the user wants to hear text spoken aloud or convert text to audio.",
      "CRITICAL: Before calling tts, you MUST first write the full text you intend to read aloud in your response as regular text, so the user can see it. Only then call tts with the same text. Never use tts without first displaying the text visually.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Text to convert to speech" }),
      voice: Type.Optional(
        Type.String({
          description:
            "Voice name (defaults to configured voice, e.g. zh-CN-XiaoxiaoNeural)",
        }),
      ),
      speed: Type.Optional(
        Type.Number({
          description: "Speech speed 0.5–2.0 (defaults to configured speed)",
          minimum: 0.5,
          maximum: 2.0,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const conf = getConf();
      if (!conf.enabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: "TTS is currently disabled. Use /edge-tts or Alt+V to enable it.",
            },
          ],
          details: {},
        };
      }

      const voice = params.voice ?? conf.voice;
      const speed = params.speed ?? conf.speed;
      const text = params.text;

      // Fire-and-forget: queue playback, don't block the tool
      enqueue(() => speak(text, { ...conf, voice, speed }));

      // Show the full text visually so the user can see what's being read
      const fullText = text;
      const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      return {
        content: [
          { type: "text" as const, text: `🔊 正在朗读:\n\n${fullText}` },
        ],
        details: {},
      };
    },
  });

  // ── Commands ──

  // /edge-tts interactive config
  pi.registerCommand("edge-tts", {
    description: "Configure Edge TTS voice and speed",
    handler: async (_args, ctx) => {
      const conf = getConf();
      const allVoices = getVoices();
      const voiceNames = buildVoiceOptions(allVoices);
      const currentVoiceIdx = voiceNames.indexOf(conf.voice);

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        let enabled = conf.enabled;
        let voiceIdx = currentVoiceIdx >= 0 ? currentVoiceIdx : 0;
        let speedIdx = speedToIndex(conf.speed);
        let selectedRow = 0;
        let feedback: string | null = null;

        // Voice filter
        let filterText = "";
        let filteredVoices = voiceNames;

        const rowDefs = [
          { id: "enabled" },
          { id: "voice" },
          { id: "speed" },
        ];

        function applyFilter() {
          if (!filterText) {
            filteredVoices = voiceNames;
          } else {
            const lower = filterText.toLowerCase();
            filteredVoices = voiceNames.filter((v) => v.toLowerCase().includes(lower));
          }
          // Clamp voiceIdx
          if (voiceIdx >= filteredVoices.length) voiceIdx = 0;
        }

        async function playSample() {
          const fn = getConf();
          const v = filteredVoices.length > 0 ? filteredVoices[voiceIdx] : fn.voice;
          const s = Number.parseFloat(SPEED_VALUES[speedIdx]);
          await speak("The quick brown fox jumps over the lazy dog.", { ...fn, voice: v, speed: s });
        }

        return {
          render(_width: number) {
            const lines: string[] = [];

            lines.push(theme.fg("accent", theme.bold("Edge TTS")));

            // Status line
            const totalVoices = allVoices.length;
            lines.push(`  ${theme.fg("dim", `${totalVoices} voices available`)}`);

            // Setting rows
            for (let i = 0; i < rowDefs.length; i++) {
              const row = rowDefs[i];
              const sel = i === selectedRow;
              const cursor = sel ? "→" : " ";

              if (row.id === "enabled") {
                const val = enabled ? "on" : "off";
                const left = sel ? "◂ " : "  ";
                const right = sel ? " ▸" : "";
                lines.push(`${cursor} TTS    ${left}${val}${right}`);
              } else if (row.id === "voice") {
                const current = filteredVoices[voiceIdx] ?? "-";
                const hint = current !== "-" ? getHint(current) : "";
                const left = sel ? "◂ " : "  ";
                const right = sel ? " ▸" : "";
                lines.push(`${cursor} Voice  ${left}${current}${right} ${theme.fg("dim", hint)}`);
              } else if (row.id === "speed") {
                const val = SPEED_VALUES[speedIdx];
                const left = sel ? "◂ " : "  ";
                const right = sel ? " ▸" : "";
                lines.push(`${cursor} Speed  ${left}${val}${right}`);
              }
            }

            // Voice filter (show only when voice row selected)
            if (selectedRow === 1 && filterText !== undefined) {
              lines.push(`  ${theme.fg("dim", `filter: ${filterText}_`)}`);
            }

            lines.push("");

            if (feedback) {
              // Split multi-line errors into separate lines to avoid
              // exceeding terminal width (crashes pi's TUI safety check).
              const feedbackLines = feedback.split("\n");
              for (const fbLine of feedbackLines) {
                lines.push(`  ${theme.fg("success", fbLine)}`);
              }
              feedback = null;
            }

            lines.push(
              theme.fg(
                "dim",
                " ↑↓ nav • ←→ change • s save default • r reset • enter preview • esc close",
              ),
            );

            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "escape")) {
              persistSession();
              done(undefined);
              return;
            }

            if (matchesKey(data, "s")) {
              const v = filteredVoices.length > 0 ? filteredVoices[voiceIdx] : defaults.voice;
              const sp = Number.parseFloat(SPEED_VALUES[speedIdx]);
              defaults = { ...defaults, enabled, voice: v, speed: sp };
              saveConfig(defaults);
              feedback = "✓ Saved as default";
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, "r")) {
              session = {};
              saveConfig({ ...DEFAULT_CONFIG });
              defaults = loadConfig();
              persistSession();
              enabled = defaults.enabled;
              voiceIdx = voiceNames.indexOf(defaults.voice);
              if (voiceIdx < 0) voiceIdx = 0;
              speedIdx = speedToIndex(defaults.speed);
              feedback = "✓ Reset to defaults";
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, "up")) {
              selectedRow = (selectedRow - 1 + rowDefs.length) % rowDefs.length;
              _tui.requestRender();
              return;
            }
            if (matchesKey(data, "down")) {
              selectedRow = (selectedRow + 1) % rowDefs.length;
              _tui.requestRender();
              return;
            }

            if (matchesKey(data, "enter")) {
              feedback = "▶ Playing sample…";
              _tui.requestRender();
              playSample()
                .then(() => {
                  feedback = "✓ Done";
                  _tui.requestRender();
                })
                .catch((err) => {
                  // Only show first line of error to avoid terminal-width crashes
                  const msg = err instanceof Error ? err.message : String(err);
                  feedback = `✗ ${msg.split("\n")[0]}`;
                  _tui.requestRender();
                });
              return;
            }

            const rowId = rowDefs[selectedRow]?.id;

            if (matchesKey(data, "left") || matchesKey(data, "right")) {
              const dir = matchesKey(data, "right") ? 1 : -1;
              if (rowId === "enabled") {
                enabled = !enabled;
                session.enabled = enabled;
                persistSession();
                _tui.requestRender();
                updateStatus();
                return;
              }
              if (rowId === "voice" && filteredVoices.length > 0) {
                voiceIdx = (voiceIdx + dir + filteredVoices.length) % filteredVoices.length;
                session.voice = filteredVoices[voiceIdx];
                persistSession();
                _tui.requestRender();
                return;
              }
              if (rowId === "speed") {
                speedIdx = (speedIdx + dir + SPEED_VALUES.length) % SPEED_VALUES.length;
                session.speed = Number.parseFloat(SPEED_VALUES[speedIdx]);
                persistSession();
                _tui.requestRender();
                return;
              }
            }
          },
        };
      });
    },
  });

  // /edge-voices — list available voices
  pi.registerCommand("edge-voices", {
    description: "List all available Edge TTS voices",
    handler: async (_args, ctx) => {
      const allVoices = getVoices();
      if (allVoices.length === 0) {
        ctx.ui.notify("No voices found. Is edge-tts installed?", "error");
        return;
      }

      // Show Chinese voices grouped by region
      const cn = allVoices.filter((v) => v.name.startsWith("zh-"));
      const cnLines = cn.map(
        (v) => `  ${v.name}  (${v.gender}, ${v.categories}, ${v.personality})`,
      );

      const total = allVoices.length;
      const msg = [
        `Edge TTS: ${total} voices total, ${cn.length} Chinese`,
        "",
        ...cnLines,
      ].join("\n");

      ctx.ui.notify(msg, "info");
    },
  });

  // /edge-tts-on / /edge-tts-off quick toggle
  pi.registerCommand("edge-tts-on", {
    description: "Enable Edge TTS",
    handler: async (_args, ctx) => {
      session.enabled = true;
      persistSession();
      ctx.ui.notify("Edge TTS enabled", "success");
      updateStatus();
    },
  });

  pi.registerCommand("edge-tts-off", {
    description: "Disable Edge TTS",
    handler: async (_args, ctx) => {
      session.enabled = false;
      persistSession();
      ctx.ui.notify("Edge TTS disabled", "info");
      updateStatus();
    },
  });

  // ── Shortcut ──

  pi.registerShortcut("alt+v", {
    description: "Toggle Edge TTS on/off",
    handler: async (ctx) => {
      const conf = getConf();
      session.enabled = !conf.enabled;
      persistSession();
      ctx.ui.notify(`Edge TTS ${session.enabled ? "enabled" : "disabled"}`, "info");
      updateStatus();
    },
  });

  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    restoreSession(ctx);
    updateStatus();
  });

  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    restoreSession(ctx);
    updateStatus();
  });

  pi.on("session_shutdown", async () => {
    currentCtx = undefined;
  });
}

// ── Helpers ──

function getHint(voiceName: string): string {
  const allVoices = getVoices();
  const v = allVoices.find((v) => v.name === voiceName);
  if (!v) return "";
  return `(${v.gender}, ${v.categories})`;
}
