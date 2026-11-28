/** words never accepted, shown or played by bots: slurs and strong vulgar words (edit freely; lowercase) */
export const BLOCKED_WORDS: readonly string[] = [
  'nigger', 'niggers', 'nigga', 'niggas', 'nigg', 'faggot', 'faggots', 'fag', 'fags', 'faggy', 'kike', 'kikes', 'spic', 'spics', 'spick', 'spicks',
  'chink', 'chinks', 'gook', 'gooks', 'wetback', 'wetbacks', 'coon', 'coons', 'darky', 'darkie', 'darkies', 'dyke', 'dykes', 'tranny', 'trannies',
  'retard', 'retards', 'retarded', 'raghead', 'ragheads', 'towelhead', 'paki', 'pakis', 'jap', 'japs', 'wop', 'wops', 'dago', 'dagos', 'gyp', 'gyps',
  'gypped', 'gypping', 'spaz', 'spazz', 'mong', 'mongs', 'homo', 'homos', 'lesbo', 'lesbos', 'shemale', 'squaw', 'squaws', 'beaner', 'beaners',
  'cunt', 'cunts', 'twat', 'twats', 'whore', 'whores', 'whored', 'whoring', 'slut', 'sluts', 'slutty', 'bitch', 'bitches', 'bitchy', 'bitching',
  'bastard', 'bastards', 'wank', 'wanks', 'wanker', 'wankers', 'wanked', 'wanking', 'jizz', 'cum', 'cums', 'cumming', 'dildo', 'dildos',
  'rape', 'raped', 'rapes', 'raping', 'rapist', 'rapists', 'porn', 'porno', 'pornos', 'pussy', 'pussies', 'tits', 'titty', 'titties', 'boob', 'boobs',
  'cock', 'cocks', 'dick', 'dicks', 'prick', 'pricks', 'shit', 'shits', 'shitty', 'shat', 'piss', 'pissed', 'pisses', 'pissing', 'arse', 'arses',
  'arsehole', 'arseholes', 'asshole', 'assholes', 'bollock', 'bollocks', 'bugger', 'buggers', 'buggery', 'clit', 'clits', 'penis', 'penises',
  'vagina', 'vaginas', 'anal', 'anus', 'orgasm', 'orgasms', 'horny', 'hooker', 'hookers', 'nazi', 'nazis', 'hitler',
];

/** any word starting with one of these is blocked too */
export const BLOCKED_STEMS: readonly string[] = ['fuck', 'motherfuck', 'nigger', 'faggot', 'cunt', 'shithead', 'bullshit', 'dickhead', 'wanker', 'whore', 'slut', 'jackass', 'dumbass', 'pedophil', 'paedophil'];

const words = new Set(BLOCKED_WORDS);

/** whether a word may never be used */
export function isBlocked(word: string): boolean {
  return words.has(word) || BLOCKED_STEMS.some((s) => word.startsWith(s));
}
