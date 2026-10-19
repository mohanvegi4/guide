import type { Directive } from 'vue';

/**
 * Usage: <button v-guide-anchor="'invite-button'">Invite</button>
 * Sets data-guide-id, same convention as the Angular directive — the core
 * engine's target selectors are framework-agnostic CSS attribute selectors.
 */
export const vGuideAnchor: Directive<HTMLElement, string> = {
  mounted(el, binding) {
    el.setAttribute('data-guide-id', binding.value);
  },
  updated(el, binding) {
    el.setAttribute('data-guide-id', binding.value);
  },
};
