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
  const [idea, setIdea] = useState("");

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
    // For BMAD chat: require BYOK for now.
    if (apiKey.trim().length < 8) {
      setBmadStatus("Enter your API key to start BMAD chat.");
      return;
    }
    const s = await ensureBmadSessionForRun(runId);

    setBmadStatus("Starting agent…");
    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: s.id,
        agentSkillId: bmadAgentSkillId,
        provider,
        model,
        apiKey
      })
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j?.error || `Failed to start agent (${resp.status})`);
    }
    const j = await resp.json();
    setBmadMenu(j.menu as BmadMenuItem[]);
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
    setBmadStatus("Agent started");
  }

  async function selectBmadSkill(skillId: string) {
    if (!bmadSession) return;
    setBmadStatus(`Selected ${skillId}`);
    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/select-skill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: bmadSession.id, skillId })
    });
    const j = await resp.json().catch(() => ({}));
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

    setBmadChatInput("");
    setBmadStatus("Thinking…");
    const resp = await fetch(`${API_BASE_URL}/api/bmad/sessions/message`, {
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
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j?.error || `BMAD message failed (${resp.status})`);
    setBmadSession({
      ...(j.session as BmadSession),
      primaryArtifactId: (j as any).primaryArtifactId ?? (j.session as any).primaryArtifactId ?? null
    });
    if (bmadDebugOpen) {
      fetchBmadDebug((j.session as BmadSession).id).catch(() => {});
    }
    setBmadStatus("Ready");
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

    if (!provider || !model) {
      setRunState({ status: "error", message: "Select provider and model." });
      return;
    }

    if (!idea.trim()) {
      setRunState({ status: "error", message: "Enter a product idea." });
      return;
    }

    if (useOwnKey && apiKey.trim().length < 8) {
      setRunState({ status: "error", message: "BYOK is enabled but API key is missing." });
      return;
    }

    try {
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

      // One-time runtime auth handshake (stores BYOK in the per-run container memory).
      if (useOwnKey) {
        setLogs((l) => [...l, "[ui] authenticating runtime…"]);
        const ar = await fetch(`${API_BASE_URL}/api/runtime/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: data.runId, provider, model, apiKey })
        });
        const aj = await ar.json().catch(() => ({}));
        if (!ar.ok) {
          setLogs((l) => [...l, `[ui] runtime auth failed: ${aj?.error || ar.status}`]);
        } else {
          setLogs((l) => [...l, "[ui] runtime authenticated"]);
        }
      }

      streamLogs(data.runId);
    } catch (e: any) {
      setStartedAt(null);
      setRunState({ status: "error", message: e?.message || "Failed to start run" });
    }
  }

  async function streamLogs(runId: string) {
    const es = new EventSource(`${API_BASE_URL}/api/run/${runId}/stream`);

    es.addEventListener("log", (ev) => {
      const msg = JSON.parse((ev as MessageEvent).data);
      setLogs((prev) => [...prev, msg.line]);
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
    });

    es.onerror = () => {
      es.close();
      setStartedAt(null);
      setRunState({ status: "error", message: "Stream disconnected." });
    };
  }

  const isRunning = runState.status === "running";
  const currentRunId =
    runState.status === "running"
      ? runState.runId
      : runState.status === "done"
        ? runState.runId
        : null;

  const elapsedLabel = useMemo(() => {
    const s = elapsedSec;
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }, [elapsedSec]);

  return (
    <main className="containerFull">

      <div className="appShell">
        <aside className="leftRail">
          <div className="brandRow">
            <div>
              <div className="brandName" style={{ fontSize: 22, letterSpacing: 0.2 }}>BMADly</div>
            </div>
          </div>

          <div className="railBlock">
            <div className="railBlockTitle">MISSION_CONTROL</div>
            <div className="railBlockSub">v0.1.0</div>
          </div>
          <button className={`navItem ${activeView === "environment" ? "navItemActive" : ""}`} type="button" onClick={() => setActiveView("environment")}>
            <span>Environment</span>
          </button>
          <button
            className={`navItem ${activeView === "agents" ? "navItemActive" : ""} ${!currentRunId ? "navItemDisabled" : ""}`}
            type="button"
            disabled={!currentRunId}
            onClick={() => currentRunId && setActiveView("agents")}
          >
            <span>Agent Chat</span>
          </button>
          <button
            className={`navItem ${activeView === "export" ? "navItemActive" : ""} ${!currentRunId ? "navItemDisabled" : ""}`}
            type="button"
            disabled={!currentRunId}
            onClick={() => currentRunId && setActiveView("export")}
          >
            <span>Export</span>
          </button>
        </aside>

        <div>
          <div className="topBar">
            <div className="tabsRow">
              <div className="tab tabActive">EXECUTION</div>
              <div className="tab">ANALYTICS</div>
              <div className="tab">MODELS</div>
            </div>

            <div className="row" style={{ justifyContent: "flex-end" }}>
              <div className="chip">
                <span className={currentRunId ? "ok" : "muted"}>●</span>
                <span>System Ready</span>
              </div>
              <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12, marginRight: 10 }}>Latency: 24ms</div>
              <button className="btnRun" type="button" onClick={startRun} disabled={isRunning}>
                RUN BMAD
              </button>
            </div>
          </div>

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

                  <label className="label">API Key</label>
                  <input className="input" type="password" value={apiKey} disabled={isRunning} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
                  <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                    Keys are encrypted locally and never stored on our servers.
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
                    <button className="btnRun" type="button" onClick={startRun} disabled={isRunning}>
                      RUN BMAD EXECUTION
                    </button>
                  </div>
                </section>

                <div style={{ display: "grid", gap: 16 }}>
                  <section className="card">
                    <div className="cardTitle">
                      <div className="cardTitleText">Setup Guide</div>
                    </div>
                    <div className="muted" style={{ lineHeight: 1.6 }}>
                      New to BMAD? Follow the quickstart guide to calibrate your agents.
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                      <span className="badge">CORE-V2</span>
                      <span className="badge">RUNTIME</span>
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
            </div>
          ) : null}

          {activeView === "environment" ? (
            <div className="cards2">
            <section className="card">
              <div className="cardTitle">
                <div className="cardTitleText">Environment Setup</div>
                <div className="pill">
                  <span className={isRunning ? "ok" : "muted"}>●</span>
                  <span className="muted" style={{ fontSize: 12 }}>{isRunning ? "Running" : "Ready"}</span>
                </div>
              </div>

          <div className="split2">
            <div>
              <label className="label">LLM Provider</label>
              <select
                className="select"
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderId)}
                disabled={isRunning}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Model</label>
              <select
                className="select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={isRunning}
              >
                {providerConfig.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label className="label">Product idea</label>
          <textarea
            className="input"
            value={idea}
            disabled={isRunning}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Describe the product you want to generate…"
            style={{ minHeight: 92, resize: "vertical" }}
          />

          <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
            <label className="pill" style={{ cursor: isRunning ? "not-allowed" : "pointer" }}>
              <input
                type="checkbox"
                checked={useOwnKey}
                disabled={true}
                onChange={() => {}}
                style={{ marginRight: 8 }}
              />
              API key (required)
            </label>
          </div>

          {useOwnKey && (
            <>
              <label className="label">API Key</label>
              <input
                className="input"
                type="password"
                value={apiKey}
                disabled={isRunning}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
              />
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Key is used to call the selected LLM provider and is not stored.
              </div>
            </>
          )}

          <button className="btnPrimary" onClick={startRun} disabled={isRunning}>
            {isRunning ? "Running…" : "Run BMAD"}
          </button>

          {runState.status === "error" && <div className="err" style={{ marginTop: 10 }}>{runState.message}</div>}
          {runState.status === "done" && (
            <div style={{ marginTop: 10 }} className={runState.finalStatus === "succeeded" ? "ok" : "err"}>
              {runState.finalStatus.toUpperCase()}
            </div>
          )}

          {runState.status !== "running" && currentRunId && (
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                Iterate (scoped)
              </div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button
                  className="btnSecondary"
                  type="button"
                  onClick={async () => {
                    setLogs([]);
                    setStartedAt(Date.now());
                    setElapsedSec(0);
                    setRunState({ status: "running", runId: currentRunId });
                    await fetch(`${API_BASE_URL}/api/pipeline/iterate`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        runId: currentRunId,
                        intent: "improve_ui",
                        provider,
                        model,
                        // Runtime backend uses one-time /api/runtime/auth.
                        // Keep these fields for backward compatibility but do not resend apiKey.
                        useOwnKey,
                        apiKey: undefined
                      })
                    });
                    streamLogs(currentRunId);
                  }}
                >
                  Improve UI
                </button>
                <button
                  className="btnSecondary"
                  type="button"
                  onClick={async () => {
                    setLogs([]);
                    setStartedAt(Date.now());
                    setElapsedSec(0);
                    setRunState({ status: "running", runId: currentRunId });
                    await fetch(`${API_BASE_URL}/api/pipeline/iterate`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        runId: currentRunId,
                        intent: "fix_bugs",
                        provider,
                        model,
                        useOwnKey,
                        apiKey: undefined
                      })
                    });
                    streamLogs(currentRunId);
                  }}
                >
                  Fix bugs
                </button>
                <button
                  className="btnSecondary"
                  type="button"
                  onClick={async () => {
                    const note = prompt("Feature to add?") || "";
                    if (!note.trim()) return;
                    setLogs([]);
                    setStartedAt(Date.now());
                    setElapsedSec(0);
                    setRunState({ status: "running", runId: currentRunId });
                    await fetch(`${API_BASE_URL}/api/pipeline/iterate`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        runId: currentRunId,
                        intent: "add_feature",
                        note,
                        provider,
                        model,
                        useOwnKey,
                        apiKey: undefined
                      })
                    });
                    streamLogs(currentRunId);
                  }}
                >
                  Add feature
                </button>
              </div>
            </div>
          )}
            </section>

            <section className="card">
              <div className="cardTitle">
                <div className="cardTitleText">Stdout Monitor</div>
                <div className="muted" style={{ fontSize: 12 }}>runtime + execution logs</div>
              </div>
              <div className="monoBox" style={{ maxHeight: 380, overflow: "auto" }}>
                {logs.length ? logs.join("\n") : "(logs will appear here)"}
              </div>
            </section>
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
          ) : (
            <div>
              <section className="panel" style={{ marginTop: 16 }}>
                <div style={{ display: "grid", gap: 12 }}>
                  <div>
                    <div className="sectionTitle">
                      <div className="sectionTitleText">BMAD Chat</div>
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

                    <div className="output" style={{ display: "grid", gap: 10 }}>
                      <div className="row" style={{ flexWrap: "wrap" }}>
                        <select
                          className="select"
                          value={bmadAgentSkillId}
                          onChange={(e) => setBmadAgentSkillId(e.target.value)}
                          disabled={!currentRunId}
                          title="BMAD agent skill id"
                        >
                          {BMAD_METHOD_AGENTS.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}{a.title ? ` (${a.title})` : ""}
                            </option>
                          ))}
                        </select>

                        <button
                          className="btnSecondary"
                          type="button"
                          onClick={() => startBmadAgent().catch((e) => setBmadStatus(e?.message || "Failed"))}
                        >
                          Start agent
                        </button>
                      </div>

                      <div className="muted" style={{ fontSize: 12 }}>
                        (Full Agent Chat restyle + send arrow CTA coming next.)
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
