// Tab-audio capture via the screen-share picker. The user picks the Spotify
// (or whatever) tab; we discard the video track and use the audio one.
// Chrome requires video:true for the tab option to appear in the picker.
export async function captureTabAudio(): Promise<MediaStream> {
  // suppressLocalAudioPlayback is the Chrome flag that mutes the source tab.
  // It's currently at top level in the spec but Chrome has also accepted it
  // nested inside the audio constraints — set both for safety.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: true,
    },
    suppressLocalAudioPlayback: true,
  } as DisplayMediaStreamOptions & { suppressLocalAudioPlayback: boolean });

  const audio = stream.getAudioTracks()[0];
  const video = stream.getVideoTracks()[0];

  if (!audio) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('No audio in the captured stream. Pick a Chrome Tab (not Window/Screen) and tick "Share tab audio".');
  }

  const surface = (video?.getSettings() as MediaTrackSettings & { displaySurface?: string })?.displaySurface;
  console.log('[capture] surface:', surface, 'audio settings:', audio.getSettings());

  if (surface && surface !== 'browser') {
    stream.getTracks().forEach(t => t.stop());
    throw new Error(
      `You captured "${surface}". Source-audio suppression only works for Chrome Tab captures. ` +
      `Click Capture tab again, pick the Chrome Tab option (top of the picker), and select the Spotify tab.`
    );
  }

  // Belt-and-braces: ask the live track to apply the suppression too. Some
  // Chrome versions only honor it via applyConstraints rather than at request time.
  try {
    await audio.applyConstraints({ suppressLocalAudioPlayback: true } as MediaTrackConstraints);
  } catch (e) {
    console.warn('[capture] applyConstraints(suppressLocalAudioPlayback) failed:', e);
  }

  // Drop the video track — we only want audio.
  stream.getVideoTracks().forEach(t => t.stop());
  return new MediaStream([audio]);
}
