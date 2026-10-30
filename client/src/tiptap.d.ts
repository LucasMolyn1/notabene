// Commandes TipTap propres à Notabene (déclarées par augmentation de module : le code est en JavaScript).
import '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: { setCallout: (attrs?: { type?: string }) => ReturnType };
  }
}
