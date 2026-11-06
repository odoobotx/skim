import { HOME_SCENES, type HomeStage } from "../home-scene";

type Photo = { stage: HomeStage; mode: "default" | "custom"; image: string };
let photos = $state<Partial<Record<HomeStage, Photo>>>({});
let ready = $state(false);
let loadError = $state(false);
let loading: Promise<void> | null = null;

// Photos belong to this device's webview, outside mailbox settings and IPC.
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("skim-home-backgrounds", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("photos", { keyPath: "stage" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function load() {
  if (ready) return;
  if (loading) return loading;
  loadError = false;
  loading = (async () => {
    const db = await database();
    try {
      const saved = await new Promise<Photo[]>((resolve, reject) => {
        const request = db.transaction("photos").objectStore("photos").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      photos = Object.fromEntries(saved.filter(photo => photo && Object.hasOwn(HOME_SCENES, photo.stage)
        && (photo.mode === "default" || photo.mode === "custom")
        && typeof photo.image === "string" && photo.image.startsWith("data:image/jpeg;base64,")
        && photo.image.length <= 4_000_000).map(photo => [photo.stage, photo]));
      ready = true;
    } finally { db.close(); }
  })().catch(() => { loadError = true; }).finally(() => { loading = null; });
  return loading;
}

async function save(photo: Photo) {
  if (!ready) throw new Error("Photo storage is unavailable. Please try again.");
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("photos", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Couldn't save this photo."));
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore("photos").put(photo);
    });
    photos = { ...photos, [photo.stage]: photo };
  } finally { db.close(); }
}

async function preparePhoto(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a JPG, PNG or WebP photo.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose a photo smaller than 20 MB.");
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read this photo. Please choose it again."));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = source;
  try { await image.decode(); }
  catch { throw new Error("This photo couldn't be opened. Try another JPG, PNG or WebP."); }
  const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Couldn't prepare this photo. Please try again.");
  context.fillStyle = "#17342f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const result = canvas.toDataURL("image/jpeg", .85);
  if (result.length > 4_000_000) throw new Error("This photo is too detailed to save. Try a smaller image.");
  return result;
}

export const homeBackgrounds = {
  get ready() { return ready; },
  get loadError() { return loadError; },
  load,
  mode(stage: HomeStage) { return photos[stage]?.mode ?? "default"; },
  hasCustom(stage: HomeStage) { return !!photos[stage]?.image; },
  image(stage: HomeStage) {
    const photo = photos[stage];
    return photo?.mode === "custom" ? photo.image : HOME_SCENES[stage].image;
  },
  async setMode(stage: HomeStage, mode: "default" | "custom") {
    const photo = photos[stage];
    if (!photo) {
      if (mode === "custom") throw new Error("Choose a custom photo first.");
      return;
    }
    await save({ ...photo, mode });
  },
  async upload(stage: HomeStage, file: File) {
    await save({ stage, mode: "custom", image: await preparePhoto(file) });
  },
};
