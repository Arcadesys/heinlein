// Independent visible editor expectations; raw native save expectations remain in ack.ts.
// CodeMirror's LF display is deliberately different from byte-preserved mixed source.
export const visibleSeed='Synthetic café — 🦊\nSecond line\n第三行\nFinal original';
export const visibleExpected=visibleSeed+'\nLatest revision: naïve 🌈\n';
