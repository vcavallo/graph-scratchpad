// The app's name: Graph Paper, unless a build names it otherwise (VITE_APP_NAME; see vite.config.ts).
export const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'Graph Paper'

/** A website about the app, when a build has one (VITE_APP_SITE, an https URL): Settings → About links to it. */
export const APP_SITE: string = import.meta.env.VITE_APP_SITE || ''

/** Where to email about the app, when a build has an address (VITE_APP_CONTACT): Settings → About offers it. */
export const APP_CONTACT: string = import.meta.env.VITE_APP_CONTACT || ''

/** Bug reports and feature requests: the open-source repo's issues. */
export const ISSUES_URL = 'https://github.com/vcavallo/graph-scratchpad/issues'
