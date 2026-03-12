import { requiredMicConstraints } from './media_constraints.js';

export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface NavigatorLike {
  mediaDevices: MediaDevicesLike;
}

export async function requestMicStream(navigatorLike: NavigatorLike): Promise<MediaStream> {
  return navigatorLike.mediaDevices.getUserMedia(requiredMicConstraints());
}
