// Budget de jetons de l'assistant de rédaction : un texte court ne doit pas recevoir un plafond qu'un modèle « à raisonnement »
// dépense entièrement en réflexion cachée (constaté : 500 jetons, aucun texte renvoyé).
import { describe, expect, it } from 'vitest';
import { buildAssistPrompt, type AssistInput } from '../src/ai/assist.js';

const prompt = (length: number) => buildAssistPrompt({ pageId: 'p', action: 'shorten', text: 'a'.repeat(length) } as AssistInput);

describe('plafond de jetons de l’assistant', () => {
  it('texte court : au moins 2000 jetons', () => {
    expect(prompt(10).maxTokens).toBe(2000);
    expect(prompt(300).maxTokens).toBe(2000);
  });
  it('texte moyen : proportionnel à la sélection', () => {
    expect(prompt(6000).maxTokens).toBe(3000);
  });
  it('texte long : plafonné à 4000', () => {
    expect(prompt(20_000).maxTokens).toBe(4000);
  });
});
