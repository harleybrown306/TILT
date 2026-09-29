"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { claimWorkoutAudioCues, claimWorkoutVoicePrompts, planWorkoutAudioCues, planWorkoutVoicePrompts, type WorkoutAudioCueKind, type WorkoutAudioTransition, type WorkoutVoicePrompt } from "@/lib/workout-audio-cues";

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

const tones: Record<WorkoutAudioCueKind, { frequency: number; duration: number }> = {
  work_start: { frequency: 660, duration: 0.11 },
  ten_seconds: { frequency: 880, duration: 0.08 },
  rest_start: { frequency: 440, duration: 0.16 },
  workout_complete: { frequency: 740, duration: 0.22 },
};

export function useWorkoutAudio() {
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [audioAvailability, setAudioAvailability] = useState<"unknown" | "available" | "unavailable">("unknown");
  const enabled = useRef(false);
  const context = useRef<AudioContext | null>(null);
  const emitted = useRef(new Set<string>());
  const mounted = useRef(true);
  const unlockGeneration = useRef(0);

  const setAvailability = useCallback((generation: number, value: "available" | "unavailable") => {
    if (mounted.current && unlockGeneration.current === generation) setAudioAvailability(value);
  }, []);

  const cancelSpeech = useCallback(() => {
    try { window.speechSynthesis?.cancel(); } catch {
      // Speech is optional. A browser queue failure must not affect training.
    }
  }, []);

  const unlock = useCallback(() => {
    const generation = ++unlockGeneration.current;
    enabled.current = true;
    setSoundEnabled(true);
    try {
      const AudioContextConstructor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (!AudioContextConstructor) { setAvailability(generation, "unavailable"); return; }
      if (!context.current || context.current.state === "closed") context.current = new AudioContextConstructor();
      const audio = context.current;
      if (audio.state === "running") { setAvailability(generation, "available"); return; }
      if (audio.state !== "suspended") { setAvailability(generation, "unavailable"); return; }
      void audio.resume().then(() => {
        if (audio.state === "running") setAvailability(generation, "available");
        else setAvailability(generation, "unavailable");
      }).catch(() => setAvailability(generation, "unavailable"));
    } catch {
      // Audio is optional; browser capability errors must not affect training.
      setAvailability(generation, "unavailable");
    }
  }, [setAvailability]);

  const setEnabled = useCallback((value: boolean) => {
    enabled.current = value;
    setSoundEnabled(value);
    if (!value) { ++unlockGeneration.current; cancelSpeech(); }
    if (value) unlock();
  }, [unlock, cancelSpeech]);

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

  const speak = useCallback((prompt: WorkoutVoicePrompt) => {
    if (!enabled.current) return;
    try {
      const synthesis = window.speechSynthesis;
      const Utterance = window.SpeechSynthesisUtterance;
      if (!synthesis || !Utterance) return;
      // The queue is never allowed to carry prior-phase instructions forward.
      synthesis.cancel();
      const utterance = new Utterance(prompt.text);
      synthesis.speak(utterance);
    } catch {
      // Installed voices and browser speech behavior are not workout contracts.
    }
  }, []);

  const handleTransition = useCallback((transition: WorkoutAudioTransition) => {
    const voicePrompts = planWorkoutVoicePrompts(transition);
    // Work-start beeps are authoritative. Pause, backgrounding, skipping a
    // rest, or reaching terminal guidance also invalidates any queued speech.
    if (transition.command === "hidden" || transition.command === "pause"
        || transition.after.phase === "work" || transition.after.phase === "finished"
        || (transition.command === "skip" && voicePrompts.length === 0)) {
      cancelSpeech();
    }
    for (const audioCue of claimWorkoutAudioCues(planWorkoutAudioCues(transition), emitted.current)) {
      play(audioCue.kind);
    }
    for (const prompt of claimWorkoutVoicePrompts(voicePrompts, emitted.current)) speak(prompt);
  }, [play, speak, cancelSpeech]);

  useEffect(() => () => {
    mounted.current = false;
    cancelSpeech();
    const audio = context.current;
    context.current = null;
    if (audio && audio.state !== "closed") void audio.close().catch(() => {});
  }, [cancelSpeech]);

  return { soundEnabled, audioAvailability, unlock, setEnabled, handleTransition };
}
