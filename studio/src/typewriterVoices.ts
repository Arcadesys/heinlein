/** Kept names and files from Sound Sketchbook's Typewriter keys. */
export const TYPEWRITER_VOICES = [
  {id: 'classic', name: 'Classic mechanical', file: null},
  {id: 'sample-02', name: 'Wooden Thock', file: '02_wooden_thock.mp3'},
  {id: 'sample-07', name: 'Analog Blip', file: '07_analog_synth_blip.mp3'},
  {id: 'sample-08', name: 'Paper & Plastic', file: '08_paper_plastic_tap.mp3'},
  {id: '8-bit-triangle', name: '8-bit Triangle Wave', file: '8-bit-triangle-wave.wav'},
] as const;
export type TypewriterVoice = typeof TYPEWRITER_VOICES[number]['id'];
export function isTypewriterVoice(value: unknown): value is TypewriterVoice {
  return TYPEWRITER_VOICES.some(voice => voice.id === value);
}
