const scenes = {
  dawn: { id: "dawn", image: "/home-nature.png", greeting: "Good morning." },
  morning: { id: "morning", image: "/home-morning.png", greeting: "Good morning." },
  afternoon: { id: "afternoon", image: "/home-afternoon.png", greeting: "Good afternoon." },
  evening: { id: "evening", image: "/home-evening.png", greeting: "Good evening." },
  night: { id: "night", image: "/home-night.png", greeting: "Good night." },
} as const;

/** Local time, shared by the greeting and the bundled background photograph. */
export function homeScene(date: Date) {
  const hour = date.getHours();
  return scenes[hour < 5 || hour >= 21 ? "night" : hour < 8 ? "dawn" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"];
}
