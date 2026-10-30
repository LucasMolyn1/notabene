// Commandes TipTap propres à Notabene (déclarées par augmentation de module : le code est en JavaScript).
import '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: { setCallout: (attrs?: { type?: string }) => ReturnType };
    commentAnchor: {
      setCommentAnchor: (id: string, from: number, to: number) => ReturnType;
      removeCommentAnchor: (id: string) => ReturnType;
      setCommentStates: (live: string[], resolved: string[]) => ReturnType;
    };
  }
}
