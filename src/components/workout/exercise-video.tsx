"use client";
import { useEffect, useRef, useState } from "react";
export function safeVideoUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; } catch { return null; }
}
// Media is a visual adapter. Playback never drives workout progression or cues.
export default function ExerciseVideo({ url }: { url: string | null }) {
  const video = useRef<HTMLVideoElement>(null); const [paused, setPaused] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => { if (video.current) { video.current.muted = true; void video.current.play().catch(() => setPaused(true)); } }, [url]);
  if (!url || unavailable) return null;
  return <div className="mx-auto mt-6 max-w-xl">
    <video ref={video} src={url} autoPlay muted loop playsInline preload="metadata"
      className="w-full rounded-xl" onError={() => setUnavailable(true)} />
    <button type="button" className="mt-2 text-sm text-slate-400" onClick={() => {
      if (!video.current) return;
      if (paused) void video.current.play().then(() => setPaused(false)).catch(() => {});
      else { video.current.pause(); setPaused(true); }
    }}>{paused ? "Play demonstration" : "Pause demonstration"}</button>
  </div>;
}
