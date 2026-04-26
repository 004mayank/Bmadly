"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL, PROVIDERS } from "../lib/config";

type ProviderId = (typeof PROVIDERS)[number]["id"];

type RunResponse = { runId: string; status: string };

type RunState =
  | { status: "idle" }
  | { status: "running"; runId: string }
  | { status: "done"; runId: string; finalStatus: "succeeded" | "failed" }
  | { status: "error"; message: string };

type KeyStatus = "idle" | "dirty" | "testing" | "ok" | "saved" | "error";

type RunBanner = null | { title: string; subtitle?: string; ts: number };

type Stage =
  | "Idle"
  | "Creating run"
  | "Starting runtime"
  | "Authenticating runtime"
  | "Running pipeline"
  | "Starting agent"
  | "Agent thinking"
  | "Done"
  | "Error";

type BmadMenuItem = { code: string; description: string; skill?: string; prompt?: string };
type BmadChatMessage = { role: "user" | "assistant"; text: string; ts: number };
type BmadSession = {
  id: string;
  runId: string;
  agentSkillId?: string;
  activeSkillId?: string;
  step?: { kind: string; index: number; total?: number };
  messages: BmadChatMessage[];
  artifacts: Array<{ id: string; type: string; title?: string; content: string; createdAt: number }>;
  // Canonical "current document" pointer (preferred).
  // Provided by backend on session responses.
  primaryArtifactId?: string | null;
};

type BmadAgent = { id: string; label: string; title?: string };

const BMAD_METHOD_AGENTS: BmadAgent[] = [
  { id: "bmad-agent-analyst", label: "Mary", title: "Analyst" },
  { id: "bmad-agent-pm", label: "John", title: "Product Manager" },
  { id: "bmad-agent-ux-designer", label: "Sally", title: "UX Designer" },
  { id: "bmad-agent-architect", label: "Winston", title: "System Architect" },
  { id: "bmad-agent-dev", label: "Amelia", title: "Developer" },
  { id: "bmad-agent-tech-writer", label: "Paige", title: "Tech Writer" }
];

export default function HomePage() {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [model, setModel] = useState("gpt-4o-mini");
  // Default to BYOK for best UX.
  // Note: BMAD Chat currently requires BYOK.
  const [useOwnKey, setUseOwnKey] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<KeyStatus>("idle");
  const [keyStatusMsg, setKeyStatusMsg] = useState<string>("");
  const [idea, setIdea] = useState("");
  const [runBanner, setRunBanner] = useState<RunBanner>(null);
  const [stage, setStage] = useState<Stage>("Idle");
  const [stageDetail, setStageDetail] = useState<string>("");

  const [logs, setLogs] = useState<string[]>([]);
  const [output, setOutput] = useState<string>("");
  const [planJson, setPlanJson] = useState<string>("");
  const [reviewText, setReviewText] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [analysisMd, setAnalysisMd] = useState<string>("");
  const [prdMd, setPrdMd] = useState<string>("");
  const [bmadArtifactsFromRun, setBmadArtifactsFromRun] = useState<
    Array<{ id: string; type: string; title?: string; contentType: string; content: string; createdAt: number }>
  >([]);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);

  // --- BMAD Chat state (attached to current runId) ---
  const [bmadSession, setBmadSession] = useState<BmadSession | null>(null);
  const [bmadMenu, setBmadMenu] = useState<BmadMenuItem[] | null>(null);
  const [bmadChatInput, setBmadChatInput] = useState<string>("");
  const [bmadStatus, setBmadStatus] = useState<string>("");
  const [bmadBusy, setBmadBusy] = useState(false);
  const [bmadErrorBanner, setBmadErrorBanner] = useState<string>("");
  const [bmadAgentSkillId, setBmadAgentSkillId] = useState<string>("bmad-agent-analyst");
  const [bmadDebugOpen, setBmadDebugOpen] = useState(false);
  const [bmadDebugJson, setBmadDebugJson] = useState<string>("");

  const [activeView, setActiveView] = useState<"environment" | "agents" | "export">("environment");

  const terminalRef = useRef<HTMLDivElement | null>(null);
  const bmadChatRef = useRef<HTMLDivElement | null>(null);

  const providerConfig = useMemo(() => PROVIDERS.find((p) => p.id === provider)!, [provider]);

  useEffect(() => {
    // reset model to first for provider when provider changes
    setModel(providerConfig.models[0]);
  }, [providerConfig]);

  // --- BYOK persistence (browser-only) ---
  // Store per-provider to reduce accidental cross-provider usage.
  const apiKeyStorageKey = useMemo(() => `bmadly.apiKey.${provider}`, [provider]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(apiKeyStorageKey) || "";
      if (saved) {
        setApiKey(saved);
        setKeyStatus("saved");
        setKeyStatusMsg("Saved");
      } else {
        setKeyStatus("idle");
        setKeyStatusMsg("");
      }
    } catch {
      // ignore (private mode / blocked storage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyStorageKey]);

  // Mark unsaved changes when user edits the key.
  useEffect(() => {
    if (!apiKey) {
      if (keyStatus !== "idle") {
        setKeyStatus("idle");
        setKeyStatusMsg("");
      }
      return;
    }
    if (keyStatus === "saved" || keyStatus === "testing") return;
    setKeyStatus("dirty");
  }, [apiKey]);

  function saveApiKey() {
    try {
      localStorage.setItem(apiKeyStorageKey, apiKey);
      setKeyStatus("saved");
      setKeyStatusMsg("Saved");
      setLogs((l) => [...l, `[ui] saved API key locally for ${provider}`]);
    } catch {
      setKeyStatus("error");
      setKeyStatusMsg("Storage unavailable");
      setLogs((l) => [...l, `[ui] failed to save API key (storage unavailable)`]);
    }
  }

  function clearSavedApiKey() {
    try {
      localStorage.removeItem(apiKeyStorageKey);
    } catch {
      // ignore
    }
    setApiKey("");
    setKeyStatus("idle");
    setKeyStatusMsg("");
    setLogs((l) => [...l, `[ui] cleared saved API key for ${provider}`]);
  }

  async function testApiKey() {
    if (apiKey.trim().length < 8) return;
    setKeyStatus("testing");
    setKeyStatusMsg("Testing…");
    setLogs((l) => [...l, `[ui] testing ${provider} key…`]);
    try {
      if (provider === "openai") {
        const r = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j?.error?.message || `Authentication failed (${r.status})`);
        }
      } else if (provider === "anthropic") {
        // Anthropic supports direct browser access with this header
        const r = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
          }
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j?.error?.message || `Authentication failed (${r.status})`);
        }
      } else if (provider === "gemini") {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
        );
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j?.error?.message || `Authentication failed (${r.status})`);
        }
      }

      setKeyStatus("ok");
      setKeyStatusMsg("Test successful");
      setLogs((l) => [...l, "[ui] key test succeeded"]);
    } catch (e: any) {
      const msg = e?.message || "Test failed";
      setKeyStatus("error");
      setKeyStatusMsg(msg);
      setLogs((l) => [...l, `[ui] key test failed: ${msg}`]);
    }
  }

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [logs]);

  useEffect(() => {
    bmadChatRef.current?.scrollTo({ top: bmadChatRef.current.scrollHeight });
  }, [bmadSession?.messages?.length]);

  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 250);
    return () => clearInterval(t);
  }, [startedAt]);

  function clearPanels() {
    setLogs([]);
    setOutput("");
    setPlanJson("");
    setReviewText("");
    setPreviewUrl("");
    setAnalysisMd("");
    setPrdMd("");
    setBmadArtifactsFromRun([]);
    setRunState({ status: "idle" });
    setStartedAt(null);
    setElapsedSec(0);

    setBmadSession(null);
    setBmadMenu(null);
    setBmadChatInput("");
    setBmadStatus("");
  }

  async function ensureBmadSessionForRun(runId: string) {
    if (bmadSession?.runId === runId) return bmadSession;
    setBmadStatus("Creating BMAD session…");

    // Prefer resuming the most recent existing session for this run.
    const list = await fetch(`${API_BASE_URL}/api/bmad/sessions?runId=${encodeURIComponent(runId)}`);
    if (list.ok) {
      const lj = await list.json().catch(() => null);
      const sessions = (lj?.sessions ?? []) as BmadSession[];
      if (sessions.length) {
        setBmadSession(sessions[0]);
        setBmadStatus("Resumed BMAD session");
        return sessions[0];
      }
    }

    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId })
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j?.error || `Failed to create BMAD session (${resp.status})`);
    }
    const j = await resp.json();
    setBmadSession(j.session as BmadSession);
    setBmadStatus("BMAD session ready");
    return j.session as BmadSession;
  }

  async function startBmadAgent() {
    let runId = currentRunId;
    if (!runId) {
      setBmadStatus("Creating run…");
      const r = await fetch(`${API_BASE_URL}/api/pipeline/create`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to create run (${r.status})`);
      runId = String(j.runId);
      // Keep local runState so the runId badge shows up.
      setRunState({ status: "done", runId, finalStatus: "succeeded" });
    }

    // Ensure the runtime container for this runId is authenticated before starting BMAD.
    // (Agent Chat can be opened independently of the Execution tab, so we can't assume
    // the one-time auth handshake already happened.)
    if (apiKey.trim().length >= 8) {
      try {
        await fetch(`${API_BASE_URL}/api/runtime/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, provider, model, apiKey })
        });
      } catch {
        // best-effort; backend BMAD proxy also attempts auto-auth
      }
    }
    // For BMAD chat: require BYOK for now.
    if (apiKey.trim().length < 8) {
      setBmadStatus("Enter your API key to start BMAD chat.");
      return;
    }
    const s = await ensureBmadSessionForRun(runId);

    // Seed context so the agent doesn't ask the user to restate the idea.
    // This is a lightweight "first user turn" that pins the project in the chat history.
    if (idea.trim()) {
      setBmadSession((prev) => {
        if (!prev) return prev;
        const alreadySeeded = prev.messages?.some((m) => m.role === "user" && m.text.startsWith("Project:"));
        if (alreadySeeded) return prev;
        return {
          ...prev,
          messages: [...(prev.messages || []), { role: "user", text: `Project: ${idea.trim()}`, ts: Date.now() }]
        };
      });
    }

    setBmadErrorBanner("");
    setStage("Starting agent");
    setStageDetail("");
    setBmadBusy(true);
    setBmadStatus("Starting agent…");
    // If the session vanished server-side (in-memory store), recreate once and retry.
    let resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: s.id,
        agentSkillId: bmadAgentSkillId,
        provider,
        model,
        apiKey,
        // best-effort extra context; backend may ignore
        idea
      })
    });

    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      const err = String(j?.error || "");
      const canRetry = resp.status === 404 && err.toLowerCase().includes("session not found");
      if (canRetry && runId) {
        setBmadStatus("BMAD session expired; recreating…");
        const s2 = await ensureBmadSessionForRun(runId);
        resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: s2.id,
            agentSkillId: bmadAgentSkillId,
            provider,
            model,
            apiKey,
            idea
          })
        });
      } else {
        setBmadBusy(false);
        setStage("Error");
        setStageDetail(j?.error || `Failed to start agent (${resp.status})`);
        throw new Error(j?.error || `Failed to start agent (${resp.status})`);
      }
    }

    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      setBmadBusy(false);
      setStage("Error");
      setStageDetail(j?.error || `Failed to start agent (${resp.status})`);
      throw new Error(j?.error || `Failed to start agent (${resp.status})`);
    }

    const j = await resp.json();
    setBmadMenu(j.menu as BmadMenuItem[]);
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
    setBmadBusy(false);
    setBmadStatus("Agent started");
    setStage("Idle");
    setStageDetail("");
  }

  async function selectBmadSkill(skillId: string) {
    if (!bmadSession) return;
    setBmadStatus(`Selected ${skillId}`);
    let resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/select-skill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: bmadSession.id, skillId })
    });
    let j = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = String(j?.error || "");
      const canRetry = resp.status === 404 && err.toLowerCase().includes("session not found");
      if (canRetry && currentRunId) {
        setBmadStatus("BMAD session expired; recreating…");
        const s2 = await ensureBmadSessionForRun(currentRunId);
        resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/select-skill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: s2.id, skillId })
        });
        j = await resp.json().catch(() => ({}));
      }
    }
    if (!resp.ok) throw new Error(j?.error || `Failed to select skill (${resp.status})`);
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
  }

  async function sendBmadChat(overrideMessage?: string) {
    if (!bmadSession) {
      setBmadStatus("Start an agent first.");
      return;
    }
    const msg = (overrideMessage ?? bmadChatInput).trim();
    if (!msg) return;

    if (apiKey.trim().length < 8) {
      setBmadStatus("Enter your API key to chat.");
      return;
    }

    setBmadErrorBanner("");
    setStage("Agent thinking");
    setStageDetail("");
    setBmadBusy(true);
    setBmadChatInput("");
    setBmadStatus("Thinking…");
    let resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: bmadSession.id,
        message: msg,
        provider,
        model,
        apiKey
      })
    });

    let j = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = String(j?.error || "");
      const canRetry = resp.status === 404 && err.toLowerCase().includes("session not found");
      if (canRetry && currentRunId) {
        setBmadStatus("BMAD session expired; recreating…");
        const s2 = await ensureBmadSessionForRun(currentRunId);
        resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: s2.id,
            message: msg,
            provider,
            model,
            apiKey
          })
        });
        j = await resp.json().catch(() => ({}));
      }
    }

    if (!resp.ok) {
      setBmadBusy(false);
      const msg = j?.error || `BMAD message failed (${resp.status})`;
      setBmadErrorBanner(msg);
      setStage("Error");
      setStageDetail(msg);
      throw new Error(msg);
    }
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
    if (bmadDebugOpen) {
      fetchBmadDebug((j.session as BmadSession).id).catch(() => {});
    }
    setBmadBusy(false);
    setBmadStatus("Ready");
    setStage("Idle");
    setStageDetail("");
  }

  async function fetchBmadDebug(sessionId: string) {
    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/${encodeURIComponent(sessionId)}/debug`);
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j?.error || `Debug failed (${resp.status})`);
    setBmadDebugJson(JSON.stringify(j, null, 2));
  }

  async function startRun() {
    setOutput("");
    setLogs([]);
    setPlanJson("");
    setReviewText("");
    setPreviewUrl("");
    setAnalysisMd("");
    setPrdMd("");
    setStartedAt(Date.now());
    setElapsedSec(0);
    setStage("Running pipeline");
    setStageDetail("");

    if (!provider || !model) {
      setRunState({ status: "error", message: "Select provider and model." });
      setStage("Error");
      setStageDetail("Select provider and model.");
      return;
    }

    if (!idea.trim()) {
      setRunState({ status: "error", message: "Enter a product idea." });
      setStage("Error");
      setStageDetail("Enter a product idea.");
      return;
    }

    if (useOwnKey && apiKey.trim().length < 8) {
      setRunState({ status: "error", message: "BYOK is enabled but API key is missing." });
      setStage("Error");
      setStageDetail("API key missing.");
      return;
    }

    try {
      // Prevent accidental double-starts (can create multiple runtime containers).
      if (runState.status === "running") {
        setStage("Running pipeline");
        setStageDetail("Already running");
        return;
      }

      const resp = await fetch(`${API_BASE_URL}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model,
          useOwnKey,
          apiKey: useOwnKey ? apiKey : undefined,
          input: { idea }
        })
      });

      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j?.error || `Request failed (${resp.status})`);
      }

      const data = (await resp.json()) as RunResponse;
      setRunState({ status: "running", runId: data.runId });

      // Pinning: currentRunId is derived from runState; keep runState authoritative.

      // Nudge user into Agent Chat after execution begins.
      setRunBanner({
        title: `Wonderful, lets build “${idea.trim()}”`,
        subtitle: "Opening Agent Chat…",
        ts: Date.now()
      });
      setActiveView("agents");

      // One-time runtime auth handshake (stores BYOK in the per-run container memory).
      if (useOwnKey) {
        setStage("Authenticating runtime");
        setStageDetail("");
        setLogs((l) => [...l, "[ui] authenticating runtime…"]);
        const ar = await fetch(`${API_BASE_URL}/api/runtime/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: data.runId, provider, model, apiKey })
        });
        const aj = await ar.json().catch(() => ({}));
        if (!ar.ok) {
          setLogs((l) => [...l, `[ui] runtime auth failed: ${aj?.error || ar.status}`]);
          setStage("Error");
          setStageDetail(String(aj?.error || ar.status));
        } else {
          setLogs((l) => [...l, "[ui] runtime authenticated"]);
          setStage("Running pipeline");
          setStageDetail("");
        }
      }

      streamLogs(data.runId);
    } catch (e: any) {
      setStartedAt(null);
      setRunState({ status: "error", message: e?.message || "Failed to start run" });
      setStage("Error");
      setStageDetail(e?.message || "Failed to start run");
    }
  }

  async function streamLogs(runId: string) {
    const es = new EventSource(`${API_BASE_URL}/api/run/${runId}/stream`);

    es.addEventListener("log", (ev) => {
      const msg = JSON.parse((ev as MessageEvent).data);
      setLogs((prev) => [...prev, msg.line]);

      // Heuristic: surface common fatal runtime failures in the Agent Chat UI.
      const line = String(msg.line || "");
      if (line.toLowerCase().includes("creating") && line.toLowerCase().includes("container")) {
        setStage("Starting runtime");
        setStageDetail("");
      }
      if (line.toLowerCase().includes("pull") && line.toLowerCase().includes("image")) {
        setStage("Starting runtime");
        setStageDetail("Pulling image");
      }
      if (
        line.includes("port is already allocated") ||
        line.includes("EADDRINUSE") ||
        line.toLowerCase().includes("runtime container failed")
      ) {
        setBmadErrorBanner(line);
        setBmadStatus("Runtime error");
        setStage("Error");
        setStageDetail(line);
        setBmadBusy(false);
      }
    });

    es.addEventListener("done", async (ev) => {
      const msg = JSON.parse((ev as MessageEvent).data);
      es.close();

      const finalStatus = msg.status as "succeeded" | "failed";
      setRunState({ status: "done", runId, finalStatus });
      setStartedAt(null);

      // fetch result
      const r = await fetch(`${API_BASE_URL}/api/run/${runId}/result`);
      const j = await r.json().catch(() => null);
      const result = j?.output;
      if (result?.artifacts?.analysis?.content) setAnalysisMd(String(result.artifacts.analysis.content));
      if (result?.artifacts?.prd?.content) setPrdMd(String(result.artifacts.prd.content));
      if (Array.isArray(result?.artifacts?.bmad)) setBmadArtifactsFromRun(result.artifacts.bmad);
      if (result?.plan) setPlanJson(JSON.stringify(result.plan, null, 2));
      if (result?.review) setReviewText(JSON.stringify(result.review, null, 2));
      // live preview URL may be absolute (http://localhost:PORT)
      if (j?.previewUrl) setPreviewUrl(String(j.previewUrl));
      setOutput(JSON.stringify(result ?? null, null, 2));

      // If we reached done, clear any transient busy flags.
      setBmadBusy(false);
      setStage("Done");
      setStageDetail(finalStatus);
    });

    es.onerror = () => {
      es.close();
      setStartedAt(null);
      setRunState({ status: "error", message: "Stream disconnected." });
      setBmadBusy(false);
      setStage("Error");
      setStageDetail("Stream disconnected");
    };
  }

  const isRunning = runState.status === "running";
  const currentRunId =
    runState.status === "running"
      ? runState.runId
      : runState.status === "done"
        ? runState.runId
        : null;

  // Gate Agent Chat tab: require a runId, a product idea, and a tested+saved key.
  const canOpenAgentChat = useMemo(() => {
    return Boolean(currentRunId && idea.trim().length > 0 && keyStatus === "saved");
  }, [currentRunId, idea, keyStatus]);

  const elapsedLabel = useMemo(() => {
    const s = elapsedSec;
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }, [elapsedSec]);

  return (
    <main className="containerFull">

      {/* Full-width header spanning the entire viewport */}
      <header className="fullHeader">
        <div className="brandArea">
          <div className="brandMark" />
          <span className="brandName" style={{ fontSize: 14, fontWeight: 900, letterSpacing: 0.5 }}>Bmadly</span>
        </div>
        <div className="tabsRow">
          <div className="tab tabActive">EXECUTION</div>
          <div className="tab">ANALYTICS</div>
          <div className="tab">MODELS</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="iconBtn" type="button" title="Grid view">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.3"/></svg>
          </button>
          <button className="iconBtn" type="button" title="Notifications">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2a4.5 4.5 0 00-4.5 4.5c0 2.5-.5 3.5-1 4h11c-.5-.5-1-1.5-1-4A4.5 4.5 0 008 2z" stroke="currentColor" strokeWidth="1.3"/><path d="M6.5 13.5a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
          </button>
          <button className="iconBtn" type="button" title="Messages">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="9" rx="2" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 11.5L3 14l3-1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/><path d="M4.5 6.5h7M4.5 8.5h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
          </button>
          <button className="btnRun" type="button" onClick={startRun} disabled={isRunning} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg>
            RUN BMAD
          </button>
        </div>
      </header>

      <div className="appShell">
        <aside className="leftRail">
          <div className="railBlock" style={{ marginTop: 0 }}>
            <div className="railBlockTitle">MISSION_CONTROL</div>
            <div className="railBlockSub">V.2.0.4-STABLE</div>
          </div>
          <button className={`navItem ${activeView === "environment" ? "navItemActive" : ""}`} type="button" onClick={() => setActiveView("environment")}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ opacity: 0.85 }}>
                <rect x="1" y="2" width="13" height="1.5" rx="0.75" fill="currentColor"/>
                <circle cx="4.5" cy="2.75" r="1.5" fill="currentColor"/>
                <rect x="1" y="6.75" width="13" height="1.5" rx="0.75" fill="currentColor"/>
                <circle cx="10.5" cy="7.5" r="1.5" fill="currentColor"/>
                <rect x="1" y="11.5" width="13" height="1.5" rx="0.75" fill="currentColor"/>
                <circle cx="6.5" cy="12.25" r="1.5" fill="currentColor"/>
              </svg>
              Environment
            </span>
          </button>
          <button
            className={`navItem ${activeView === "agents" ? "navItemActive" : ""} ${!canOpenAgentChat ? "navItemDisabled" : ""}`}
            type="button"
            disabled={!canOpenAgentChat}
            onClick={() => canOpenAgentChat && setActiveView("agents")}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ opacity: 0.85 }}>
                <rect x="2" y="4" width="11" height="8" rx="2" stroke="currentColor" strokeWidth="1.3" fill="none"/>
                <circle cx="5" cy="8" r="1" fill="currentColor"/>
                <circle cx="10" cy="8" r="1" fill="currentColor"/>
                <path d="M5.5 11c.5.7 3.5.7 4 0" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                <path d="M7.5 4V2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                <circle cx="7.5" cy="2" r="0.7" fill="currentColor"/>
              </svg>
              Agent Chat
            </span>
          </button>
          <button
            className={`navItem ${activeView === "export" ? "navItemActive" : ""} ${!currentRunId ? "navItemDisabled" : ""}`}
            type="button"
            disabled={!currentRunId}
            onClick={() => currentRunId && setActiveView("export")}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ opacity: 0.85 }}>
                <path d="M7.5 1.5v8M4.5 6.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              Export
            </span>
          </button>

          <div style={{ flex: 1 }} />

          <button
            className="btnNextAgent"
            type="button"
            onClick={() => canOpenAgentChat && setActiveView("agents")}
            disabled={!canOpenAgentChat}
          >
            NEXT AGENT
          </button>

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.07)", paddingTop: 12, display: "grid", gap: 4, marginTop: 12 }}>
            <button className="navItem" type="button" style={{ opacity: 0.6, fontSize: 12 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.2"/><path d="M6.5 5.5v4M6.5 3.5h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                Documentation
              </span>
            </button>
            <button className="navItem" type="button" style={{ opacity: 0.6, fontSize: 12 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="3" width="11" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M3 6h7M3 8.5h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg>
                System Logs
              </span>
            </button>
          </div>
        </aside>

        <div>
          {activeView === "environment" ? (
            <div style={{ padding: "0 22px 22px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <div className="pageTitle">Environment Setup</div>
                  <p className="pageSubtitle">Initialize your model orchestration parameters to begin execution.</p>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="chip">
                    <span className={currentRunId ? "ok" : "muted"}>●</span>
                    <span>System Ready</span>
                  </div>
                  <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>Latency: 24ms</div>
                </div>
              </div>

              <div className="cards2" style={{ marginTop: 16 }}>
                <section className="card">
                  <div className="cardTitle">
                    <div className="cardTitleText">GLOBAL CONFIGURATION</div>
                  </div>

                  <div className="split2">
                    <div>
                      <label className="label">LLM Provider</label>
                      <select className="select" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)} disabled={isRunning}>
                        {PROVIDERS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label">Model Version</label>
                      <select className="select" value={model} onChange={(e) => setModel(e.target.value)} disabled={isRunning}>
                        {providerConfig.models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <label className="label">Describe your product</label>
                  <textarea
                    className="input"
                    value={idea}
                    disabled={isRunning}
                    onChange={(e) => setIdea(e.target.value)}
                    placeholder="Describe the product you want to build — BMAD agents will use this as their primary context…"
                    style={{ minHeight: 92, resize: "vertical" }}
                  />

                  <label className="label">API Key</label>

                  {keyStatus === "saved" ? (
                    <div className="inputMasked">
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
                        <rect x="2" y="5.5" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                        <path d="M4 5.5V4a2.5 2.5 0 015 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                      </svg>
                      <span>{"sk-" + "•".repeat(36)}</span>
                    </div>
                  ) : (
                    <input
                      className="input"
                      type="password"
                      value={apiKey}
                      disabled={isRunning || keyStatus === "testing"}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-…"
                    />
                  )}

                  <div className="row" style={{ marginTop: 10, justifyContent: "space-between", alignItems: "center", minHeight: 34 }}>
                    <div className="row" style={{ gap: 7 }}>
                      {keyStatus !== "idle" && (
                        <>
                          <span
                            style={{ fontSize: 9 }}
                            className={keyStatus === "saved" || keyStatus === "ok" ? "ok" : keyStatus === "error" ? "err" : "muted"}
                          >●</span>
                          <span className="muted" style={{ fontSize: 12 }}>
                            {keyStatus === "saved" ? "Saved"
                              : keyStatus === "ok" ? "Test successful — click Save Key"
                              : keyStatus === "testing" ? "Testing…"
                              : keyStatus === "error" ? (keyStatusMsg || "Error")
                              : "Not saved"}
                          </span>
                        </>
                      )}
                    </div>

                    {(keyStatus === "dirty" || keyStatus === "testing" || keyStatus === "ok" || keyStatus === "error" || keyStatus === "saved") && (
                      <div className="row" style={{ gap: 8 }}>
                        {keyStatus !== "saved" && (
                          <button
                            className="btnRun"
                            type="button"
                            disabled={isRunning || keyStatus === "testing" || apiKey.trim().length < 8}
                            onClick={keyStatus === "ok" ? saveApiKey : testApiKey}
                            style={{ padding: "8px 14px", fontSize: 12, letterSpacing: "0.05em" }}
                          >
                            {keyStatus === "testing" ? "TESTING…" : keyStatus === "ok" ? "SAVE KEY" : "TEST KEY"}
                          </button>
                        )}
                        <button
                          className="btnSecondary"
                          type="button"
                          disabled={isRunning}
                          onClick={clearSavedApiKey}
                          style={{ padding: "8px 12px", fontSize: 12 }}
                        >
                          CLEAR
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                    Keys are encrypted locally and never stored on our servers.
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
                    {runState.status === "error" ? (
                      <div className="err" style={{ marginRight: 12, alignSelf: "center" }}>
                        {runState.message}
                      </div>
                    ) : runState.status === "running" ? (
                      <div className="muted" style={{ marginRight: 12, alignSelf: "center", fontFamily: "var(--mono)", fontSize: 12 }}>
                        Running… {elapsedLabel}
                      </div>
                    ) : runState.status === "done" ? (
                      <div className={runState.finalStatus === "succeeded" ? "ok" : "err"} style={{ marginRight: 12, alignSelf: "center", fontFamily: "var(--mono)", fontSize: 12 }}>
                        {runState.finalStatus.toUpperCase()} • {currentRunId}
                      </div>
                    ) : null}
                    <button className="btnRun" type="button" onClick={startRun} disabled={isRunning} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg>
                      RUN BMAD EXECUTION
                    </button>
                  </div>
                </section>

                <div style={{ display: "grid", gap: 16 }}>
                  <section className="card">
                    <div className="cardTitle">
                      <div className="cardTitleText">Setup Guide</div>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.5 }}><path d="M2 12L12 2M12 2H6M12 2v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                    <div className="muted" style={{ lineHeight: 1.6 }}>
                      New to BMAD? Follow the quickstart guide to calibrate your agents.
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                      <span className="badge">CORE-V2</span>
                      <span className="badge">PYTHON-SDK</span>
                    </div>
                  </section>

                  <section className="card">
                    <div className="cardTitle">
                      <div className="cardTitleText">INFRASTRUCTURE</div>
                    </div>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <div className="muted">Primary Node</div>
                      <div className="ok" style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 800 }}>ONLINE</div>
                    </div>
                    <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.06)", marginTop: 10, overflow: "hidden" }}>
                      <div style={{ width: "78%", height: "100%", background: "rgba(59,130,246,0.9)" }} />
                    </div>
                    <div className="row" style={{ justifyContent: "space-between", marginTop: 14 }}>
                      <div className="muted">Inference Load</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>12.4%</div>
                    </div>
                  </section>
                </div>
              </div>

              {/* Bottom row: Agent Chat Ready + STDOUT_MONITOR */}
              <div className="cards2" style={{ marginTop: 16 }}>
                <section className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 200, textAlign: "center", gap: 16 }}>
                  <svg width="52" height="52" viewBox="0 0 52 52" fill="none" style={{ opacity: 0.45 }}>
                    <rect x="6" y="16" width="40" height="28" rx="8" stroke="currentColor" strokeWidth="2.5"/>
                    <circle cx="18" cy="30" r="4" fill="currentColor"/>
                    <circle cx="34" cy="30" r="4" fill="currentColor"/>
                    <path d="M18 40c2 3 14 3 16 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    <path d="M26 16V10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
                    <circle cx="26" cy="8" r="3" stroke="currentColor" strokeWidth="2"/>
                    <path d="M16 16V12M36 16V12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Agent Chat Ready</div>
                    <div className="muted" style={{ fontSize: 14, lineHeight: 1.6, maxWidth: 280, margin: "0 auto" }}>
                      Initialize the environment to begin live interaction with your AI agents.
                    </div>
                  </div>
                </section>

                <section className="card">
                  <div className="cardTitle">
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ color: "var(--ok)", fontSize: 10 }}>●</span>
                      <div className="cardTitleText">STDOUT_MONITOR</div>
                    </div>
                    <button className="iconBtn" type="button" title="Expand">
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1 12l4-4M1 12h4M1 12v-4M12 1l-4 4M12 1H8M12 1v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                  </div>
                  <div className="monoBox" style={{ minHeight: 152, color: "rgba(167,176,194,0.7)", fontSize: 11 }}>
                    {logs.length ? logs.slice(-20).join("\n") : "WAITING FOR PROCESS INITIALIZATION..."}
                  </div>
                </section>
              </div>
            </div>
          ) : null}

          {activeView === "agents" ? (
            <div style={{ padding: "0 22px 22px" }}>
              {runBanner ? (
                <div className="card" style={{ marginTop: 16 }}>
                  <div className="cardTitle">
                    <div className="cardTitleText">PROJECT</div>
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>{runBanner.title}</div>
                    {idea?.trim() ? (
                      <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                        Project: {idea.trim()}
                      </div>
                    ) : null}
                    {runBanner.subtitle ? <div className="muted">{runBanner.subtitle}</div> : null}
                  </div>
                </div>
              ) : (
                <div className="card" style={{ marginTop: 16 }}>
                  <div className="cardTitle">
                    <div className="cardTitleText">PROJECT</div>
                  </div>
                  <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                    Project: {idea?.trim() ? idea.trim() : "(no idea provided)"}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <div className="pageTitle">Agent Chat</div>
                  <p className="pageSubtitle">Run BMAD agents and skills on your product idea.</p>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="chip">
                    <span className={currentRunId ? "ok" : "muted"}>●</span>
                    <span>{currentRunId ? `Session: ${currentRunId}` : "No session"}</span>
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16, marginTop: 16, alignItems: "start" }}>
                {/* Left: Agents */}
                <section className="card" style={{ position: "sticky", top: 16, alignSelf: "start" }}>
                  <div className="cardTitle">
                    <div className="cardTitleText">ACTIVE AGENTS</div>
                  </div>

                  <div style={{ display: "grid", gap: 10 }}>
                    {BMAD_METHOD_AGENTS.map((a) => {
                      const isActive = bmadAgentSkillId === a.id;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          className={"btnSecondary"}
                          onClick={() => setBmadAgentSkillId(a.id)}
                          style={{
                            textAlign: "left",
                            padding: "12px 12px",
                            border: isActive ? "1px solid rgba(59,130,246,0.85)" : undefined
                          }}
                          disabled={!canOpenAgentChat}
                        >
                          <div style={{ fontWeight: 800 }}>{a.label}{a.title ? ` (${a.title})` : ""}</div>
                          <div className="muted" style={{ fontSize: 12 }}>{isActive ? "Selected" : "Click to select"}</div>
                        </button>
                      );
                    })}

                    <div className="row" style={{ justifyContent: "flex-end", marginTop: 6, gap: 10, flexWrap: "wrap" }}>
                      <button
                        className="btnRun"
                        type="button"
                        onClick={() => startBmadAgent().catch((e) => setBmadStatus(e?.message || "Failed"))}
                        disabled={!canOpenAgentChat}
                        title={!canOpenAgentChat ? "Fill product idea, test+save key, then run execution to create a session." : "Start BMAD agent"}
                      >
                        START AGENT
                      </button>
                    </div>

                    {!canOpenAgentChat ? (
                      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                        To enable Agent Chat: enter a Product idea, TEST KEY, SAVE KEY, then run BMAD execution.
                      </div>
                    ) : null}
                  </div>
                </section>

                {/* Right: Chat + Logs */}
                <div style={{ display: "grid", gap: 16 }}>
                  <section className="card">
                    <div className="cardTitle">
                      <div className="cardTitleText">BMAD CHAT INTERFACE</div>
                      <div className="muted" style={{ fontSize: 12, textAlign: "right" }}>
                        {bmadSession?.step?.kind === "bmad_steps" ? (
                          <>
                            {(bmadSession.activeSkillId || "") + " "}
                            step {bmadSession.step.index}/{bmadSession.step.total ?? "?"}
                            {bmadStatus ? ` • ${bmadStatus}` : ""}
                          </>
                        ) : (
                          bmadStatus || ""
                        )}
                      </div>
                    </div>

                    <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                      {stage !== "Idle" ? (
                        <>
                          Status: <span style={{ fontFamily: "var(--mono)", fontWeight: 800 }}>{stage}</span>
                          {stageDetail ? <span style={{ fontFamily: "var(--mono)" }}> • {stageDetail}</span> : null}
                        </>
                      ) : (
                        <>Status: <span style={{ fontFamily: "var(--mono)" }}>Ready</span></>
                      )}
                    </div>

                    {bmadErrorBanner ? (
                      <div className="err" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>
                        {bmadErrorBanner}
                      </div>
                    ) : null}

                    <div className="monoBox" style={{ minHeight: 520, maxHeight: 640, overflow: "auto" }} ref={bmadChatRef as any}>
                      {(bmadSession?.messages?.length
                        ? bmadSession.messages
                            .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}  ${new Date(m.ts).toLocaleTimeString()}\n${m.text}`)
                            .join("\n\n")
                        : "(start an agent to begin chatting)")}
                    </div>

                    {bmadMenu?.length ? (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                        {bmadMenu.slice(0, 14).map((it) => (
                          <button
                            key={it.code}
                            className="btnSecondary"
                            type="button"
                            onClick={() => {
                              if (it.skill) selectBmadSkill(it.skill).catch(() => {});
                              if (it.prompt) sendBmadChat(it.prompt).catch(() => {});
                            }}
                            disabled={!bmadSession || bmadBusy}
                            title={it.description ? String(it.description).split("\n")[0] : it.code}
                          >
                            {it.code}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    <div className="row" style={{ marginTop: 12, gap: 10 }}>
                      <input
                        className="input"
                        value={bmadChatInput}
                        onChange={(e) => setBmadChatInput(e.target.value)}
                        placeholder="Direct agent command…"
                        disabled={!bmadSession || bmadBusy}
                      />
                      <button className="btnRun" type="button" onClick={() => sendBmadChat().catch((e) => setBmadStatus(e?.message || "Failed"))} disabled={!bmadSession || bmadBusy}>
                        SEND
                      </button>
                    </div>
                  </section>

                  <section className="card">
                    <div className="cardTitle">
                      <div className="cardTitleText">LIVE OUTPUT</div>
                      <div className="muted" style={{ fontSize: 12 }}>execution logs</div>
                    </div>
                    <div className="monoBox" style={{ maxHeight: 320, overflow: "auto" }}>
                      {logs.length ? logs.join("\n") : "(logs will appear here)"}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          ) : activeView === "export" ? (
            <div className="cards2">
              <section className="card">
                <div className="cardTitle">
                  <div className="cardTitleText">Export Documents</div>
                  <div className="muted" style={{ fontSize: 12 }}>download markdown / pdf</div>
                </div>

                <div className="monoBox" style={{ minHeight: 260, maxHeight: 420, overflow: "auto" }}>
                  {(prdMd || analysisMd || output || "(no document yet — run an agent to generate artifacts)")}
                </div>
              </section>

              <section className="card">
                <div className="cardTitle">
                  <div className="cardTitleText">Download</div>
                </div>

                <div style={{ display: "grid", gap: 10 }}>
                  <button
                    className="btnPrimary"
                    type="button"
                    disabled={!prdMd && !analysisMd && !output}
                    onClick={() => {
                      const content = prdMd || analysisMd || output || "";
                      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = prdMd ? "prd.md" : analysisMd ? "analysis.md" : "bmadly-output.md";
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download .md
                  </button>

                  <button
                    className="btnSecondary"
                    type="button"
                    disabled={!prdMd && !analysisMd && !output}
                    onClick={async () => {
                      const markdown = prdMd || analysisMd || output || "";
                      const title = prdMd ? "prd" : analysisMd ? "analysis" : "bmadly-output";
                      const r = await fetch(`${API_BASE_URL}/api/export/pdf`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ markdown, title })
                      });
                      if (!r.ok) {
                        const j = await r.json().catch(() => ({}));
                        throw new Error(j?.error || `PDF export failed (${r.status})`);
                      }
                      const blob = await r.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${title}.pdf`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download .pdf
                  </button>
                </div>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
