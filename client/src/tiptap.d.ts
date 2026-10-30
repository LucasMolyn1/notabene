// Commandes TipTap propres à Notabene (déclarées par augmentation de module : le code est en JavaScript).
import '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: { setCallout: (attrs?: { type?: string }) => ReturnType };
    blocks: {
      setTextColor: (color: string) => ReturnType;
      unsetTextColor: () => ReturnType;
      setAlign: (align: string) => ReturnType;
      setDetails: () => ReturnType;
      setColumns: (count?: number) => ReturnType;
    };
    commentAnchor: {
      setCommentAnchor: (id: string, from: number, to: number) => ReturnType;
      removeCommentAnchor: (id: string) => ReturnType;
      setCommentStates: (live: string[], resolved: string[]) => ReturnType;
    };
  }
}
