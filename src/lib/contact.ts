// Single source for the beta support / feedback address. Used by the Settings
// "Help & feedback" card and the sidebar footer "Send feedback" link.
export const SUPPORT_EMAIL = "support@dizosint.co.site";

/** mailto: link with a prefilled subject for beta feedback. */
export const SUPPORT_MAILTO =
  `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Insight Finder — beta feedback")}`;
