export const HOME_SCENES = {
  dawn: { id: "dawn", label: "Dawn", hours: "5–8 AM", image: "/home-nature.png", greeting: "Good morning." },
  morning: { id: "morning", label: "Morning", hours: "8 AM–noon", image: "/home-morning.png", greeting: "Good morning." },
  afternoon: { id: "afternoon", label: "Afternoon", hours: "Noon–5 PM", image: "/home-afternoon.png", greeting: "Good afternoon." },
  evening: { id: "evening", label: "Evening", hours: "5–9 PM", image: "/home-evening.png", greeting: "Good evening." },
  night: { id: "night", label: "Night", hours: "9 PM–5 AM", image: "/home-night.png", greeting: "Good night." },
} as const;

export type HomeStage = keyof typeof HOME_SCENES;

/** Local time, shared by the greeting and the bundled background photograph. */
export function homeScene(date: Date) {
  const hour = date.getHours();
  return HOME_SCENES[hour < 5 || hour >= 21 ? "night" : hour < 8 ? "dawn" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"];
}
