"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { claimWorkoutAudioCues, planWorkoutAudioCues, type WorkoutAudioCueKind, type WorkoutAudioTransition } from "@/lib/workout-audio-cues";

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

const tones: Record<WorkoutAudioCueKind, { frequency: number; duration: number }> = {
  work_start: { frequency: 660, duration: 0.11 },
  ten_seconds: { frequency: 880, duration: 0.08 },
  rest_start: { frequency: 440, duration: 0.16 },
  workout_complete: { frequency: 740, duration: 0.22 },
};

export function useWorkoutAudio() {
  const [soundEnabled, setSoundEnabled] = useState(false);
  const enabled = useRef(false);
  const context = useRef<AudioContext | null>(null);
  const emitted = useRef(new Set<string>());

  const unlock = useCallback(() => {
    enabled.current = true;
    setSoundEnabled(true);
    try {
      const AudioContextConstructor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (!AudioContextConstructor) return;
      if (!context.current || context.current.state === "closed") context.current = new AudioContextConstructor();
      if (context.current.state === "suspended") void context.current.resume().catch(() => {});
    } catch {
      // Audio is optional; browser capability errors must not affect training.
    }
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    enabled.current = value;
    setSoundEnabled(value);
    if (value) unlock();
  }, [unlock]);

  const play = useCallback((kind: WorkoutAudioCueKind) => {
    const audio = context.current;
    if (!enabled.current || !audio || audio.state !== "running") return;
    try {
      const tone = tones[kind];
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(tone.frequency, audio.currentTime);
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + tone.duration);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + tone.duration + 0.01);
    } catch {
      // A failed optional cue is intentionally silent.
    }
  }, []);

  const handleTransition = useCallback((transition: WorkoutAudioTransition) => {
    for (const audioCue of claimWorkoutAudioCues(planWorkoutAudioCues(transition), emitted.current)) {
      play(audioCue.kind);
    }
  }, [play]);

  useEffect(() => () => {
    const audio = context.current;
    context.current = null;
    if (audio && audio.state !== "closed") void audio.close().catch(() => {});
  }, []);

  return { soundEnabled, unlock, setEnabled, handleTransition };
}
