import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';

/** Landing page for the identity provider's redirect after SSO sign-in. */
@Component({
  selector: 'app-auth-callback',
  template: `<p class="muted">Signing you in…</p>`,
})
export class AuthCallbackComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async ngOnInit(): Promise<void> {
    const { error, returnUrl } = await this.auth.completeSsoSignIn();
    if (error) {
      void this.router.navigate(['/login'], { queryParams: { error } });
    } else {
      void this.router.navigateByUrl(returnUrl);
    }
  }
}
