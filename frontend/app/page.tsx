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

export default function HomePage() {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [model, setModel] = useState("gpt-4o-mini");
  const [useOwnKey, setUseOwnKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [idea, setIdea] = useState("");

  const [logs, setLogs] = useState<string[]>([]);
  const [output, setOutput] = useState<string>("");
  const [planJson, setPlanJson] = useState<string>("");
  const [reviewText, setReviewText] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);

  const terminalRef = useRef<HTMLDivElement | null>(null);

  const providerConfig = useMemo(() => PROVIDERS.find((p) => p.id === provider)!, [provider]);

  useEffect(() => {
    // reset model to first for provider when provider changes
    setModel(providerConfig.models[0]);
  }, [providerConfig]);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [logs]);

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
    setRunState({ status: "idle" });
    setStartedAt(null);
    setElapsedSec(0);
  }

  async function startRun() {
    setOutput("");
    setLogs([]);
    setPlanJson("");
    setReviewText("");
    setPreviewUrl("");
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
      const resp = await fetch(`${API_BASE_URL}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idea,
          provider,
          model,
          useOwnKey,
          apiKey: useOwnKey ? apiKey : undefined,
          input: {}
        })
      });

      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j?.error || `Request failed (${resp.status})`);
      }

      const data = (await resp.json()) as RunResponse;
      setRunState({ status: "running", runId: data.runId });
      streamLogs(data.runId);
    } catch (e: any) {
      setStartedAt(null);
      setRunState({ status: "error", message: e?.message || "Failed to start run" });
    }
  }

  async function streamLogs(runId: string) {
    const es = new EventSource(`${API_BASE_URL}/api/pipeline/run/${runId}/stream`);

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
      const r = await fetch(`${API_BASE_URL}/api/pipeline/run/${runId}/result`);
      const j = await r.json().catch(() => null);
      const result = j?.result;
      if (result?.plan) setPlanJson(JSON.stringify(result.plan, null, 2));
      if (result?.review) setReviewText(JSON.stringify(result.review, null, 2));
      if (result?.previewUrl) setPreviewUrl(`${API_BASE_URL}${result.previewUrl}`);
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
    <main>
      <header>
        <h1>Bmadly</h1>
        <p className="sub">browser-based BMAD execution</p>
      </header>

      <div className="grid">
        <section className="panel">
          <div className="titleRow">
            <div className="badge">
              <span className={isRunning ? "ok" : "muted"}>●</span>
              <span style={{ fontWeight: 600 }}>{isRunning ? "Running" : "Ready"}</span>
            </div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              {currentRunId && (
                <div className="badge" title={currentRunId}>
                  <span className="muted">runId</span>
                  <span style={{ fontSize: 12, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {currentRunId}
                  </span>
                </div>
              )}
              {isRunning && (
                <div className="badge">
                  <span className="muted">elapsed</span>
                  <span style={{ fontSize: 12 }}>{elapsedLabel}</span>
                </div>
              )}
              <button className="btnSecondary" type="button" onClick={clearPanels} disabled={isRunning}>
                Clear
              </button>
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
                disabled={isRunning}
                onChange={(e) => setUseOwnKey(e.target.checked)}
                style={{ marginRight: 8 }}
              />
              Use my own API key
            </label>
          </div>

          {useOwnKey && (
            <>
              <label className="label">API Key (sent to backend for this run only)</label>
              <input
                className="input"
                type="password"
                value={apiKey}
                disabled={isRunning}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
              />
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Keys are not persisted. Managed keys (env vars) are never exposed to the browser.
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
                        useOwnKey,
                        apiKey: useOwnKey ? apiKey : undefined
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
                        apiKey: useOwnKey ? apiKey : undefined
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
                        apiKey: useOwnKey ? apiKey : undefined
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

        <section className="panel">
          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">Plan</div>
                {planJson && (
                  <button
                    className="btnSecondary"
                    onClick={() => navigator.clipboard.writeText(planJson).catch(() => {})}
                    type="button"
                  >
                    Copy
                  </button>
                )}
              </div>
              <div className="output">
                {planJson ? planJson : <span className="muted">(plan will appear here)</span>}
              </div>
            </div>

            <div>
              <div className="terminalHeader">
                <div className="muted">Logs</div>
                {runState.status === "running" && (
                  <div className="pill">
                    <span className="muted">streaming</span>
                    <span className="ok">●</span>
                  </div>
                )}
              </div>
              <div className="terminal" ref={terminalRef}>
                {logs.length === 0 ? (
                  <span className="terminalLineDim">(logs will appear here)</span>
                ) : (
                  logs.map((line, idx) => {
                    const cls =
                      /\b(error|failed|fatal)\b/i.test(line)
                        ? "terminalLineErr"
                        : /\b(warn|warning)\b/i.test(line)
                          ? "terminalLineWarn"
                          : "terminalLine";
                    return (
                      <div key={idx} className={cls}>
                        {line}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">Preview</div>
              </div>
              <div className="output" style={{ padding: 0, overflow: "hidden" }}>
                {runState.status === "running" && !previewUrl ? (
                  <div style={{ padding: 14 }} className="muted">
                    Starting preview…
                  </div>
                ) : previewUrl ? (
                  <iframe
                    src={previewUrl}
                    style={{ width: "100%", height: 320, border: 0, borderRadius: 16 }}
                    title="preview"
                  />
                ) : (
                  <div style={{ padding: 14 }} className="muted">
                    (preview will appear here)
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">Review</div>
                {reviewText && (
                  <button
                    className="btnSecondary"
                    onClick={() => navigator.clipboard.writeText(reviewText).catch(() => {})}
                    type="button"
                  >
                    Copy
                  </button>
                )}
              </div>
              <div className="output">
                {reviewText ? reviewText : <span className="muted">(review will appear here)</span>}
              </div>
            </div>

            <div>
              <div className="sectionTitle">
                <div className="sectionTitleText">Raw result</div>
                {output && (
                  <button
                    className="btnSecondary"
                    onClick={() => {
                      navigator.clipboard.writeText(output).catch(() => {});
                    }}
                    type="button"
                  >
                    Copy
                  </button>
                )}
              </div>
              <div className="output">
                {output ? output : <span className="muted">(final output will appear here)</span>}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
