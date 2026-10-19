import { WritableSignal } from '@angular/core';
import { Observable } from 'rxjs';
import { describeError } from './api.service';

/** The three signals every page uses to show one in-flight request. */
export interface RequestState {
  busy: WritableSignal<boolean>;
  error: WritableSignal<string | null>;
  message: WritableSignal<string | null>;
}

/**
 * Runs one API call for a page: busy while it's in flight, previous
 * error/message cleared, and a human-readable error on failure. Pages pass
 * their own signals so the template bindings stay local to the component.
 */
export function runRequest<T>(state: RequestState, obs: Observable<T>, onOk: (value: T) => void): void {
  state.busy.set(true);
  state.error.set(null);
  state.message.set(null);
  obs.subscribe({
    next: (value) => {
      state.busy.set(false);
      onOk(value);
    },
    error: (err) => {
      state.busy.set(false);
      state.error.set(describeError(err));
    },
  });
}
