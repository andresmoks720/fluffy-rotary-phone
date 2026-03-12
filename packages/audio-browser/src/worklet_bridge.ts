export interface AudioWorkletLike {
  addModule(moduleUrl: string): Promise<void>;
}

export interface AudioContextWithWorklet {
  audioWorklet: AudioWorkletLike;
}

export async function registerWorklet(context: AudioContextWithWorklet, moduleUrl: string): Promise<void> {
  await context.audioWorklet.addModule(moduleUrl);
}
