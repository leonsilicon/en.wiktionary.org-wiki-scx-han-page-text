export type WiktionaryPageValue = string | [string];

declare const wiktionaryPages: Record<
	string,
	() => Promise<WiktionaryPageValue>
>;

export default wiktionaryPages;
