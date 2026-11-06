// Mock of `@tauri-apps/api/app`.
export async function getVersion(): Promise<string> {
  return "1.0.47";
}
export async function getName(): Promise<string> {
  return "Cove";
}
export async function getTauriVersion(): Promise<string> {
  return "2.0.0";
}
