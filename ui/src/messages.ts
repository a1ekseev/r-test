export const messages = {
  en: {
    email: 'Email',
    requestCode: 'Request code',
    code: 'Code',
    signIn: 'Sign in',
    signedIn: 'Signed in',
    problems: '{count, plural, one {# problem} other {# problems}} detected',
    about: 'About',
    aboutText: 'Compatibility probe for a <b>Tauri 2</b> desktop stack.',
    close: 'Close',
    language: 'Language',
  },
  de: {
    email: 'E-Mail',
    requestCode: 'Code anfordern',
    code: 'Code',
    signIn: 'Anmelden',
    signedIn: 'Angemeldet',
    problems: '{count, plural, one {# Problem} other {# Probleme}} erkannt',
    about: 'Info',
    aboutText: 'Kompatibilitaetstest fuer einen <b>Tauri 2</b> Desktop-Stack.',
    close: 'Fertig',
    language: 'Sprache',
  },
} as const;

export type Locale = keyof typeof messages;

export const locales: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
];
