import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { App } from './app';
import { AuthService } from './core/auth.service';

@Component({ template: '' })
class Blank {}

describe('App shell navigation', () => {
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', component: Blank }]),
      ],
    });
    router = TestBed.inject(Router);
    TestBed.inject(AuthService).me.set({
      user: { id: 'u', email: 'o@acme.test', name: 'Olivia', platformAdmin: false },
      orgs: [
        {
          id: 'o1',
          name: 'Acme',
          role: 'member',
          suspendedAt: null,
          apps: [
            { id: 'a1', name: 'First app', role: 'editor' },
            { id: 'a2', name: 'Second app', role: 'editor' },
          ],
        },
      ],
    });
  });

  async function at(url: string) {
    const fixture = TestBed.createComponent(App);
    await router.navigateByUrl(url);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const tab = (el: HTMLElement, text: string) =>
    Array.from(el.querySelectorAll('nav.tabs a')).find((a) => a.textContent?.trim() === text) as
      HTMLAnchorElement | undefined;

  it('keeps the app tabs on organization pages, pointing at the first app by default', async () => {
    const el = await at('/o/o1/members');
    expect(tab(el, 'Guides')?.getAttribute('href')).toBe('/o/o1/apps/a1/guides');
    expect(tab(el, 'Pages')?.getAttribute('href')).toBe('/o/o1/apps/a1/pages');
    expect(el.querySelector<HTMLSelectElement>('select[aria-label="Application"]')?.value).toBe('a1');
  });

  it('remembers the app last visited in the organization', async () => {
    const fixture = TestBed.createComponent(App);
    const el = fixture.nativeElement as HTMLElement;
    await router.navigateByUrl('/o/o1/apps/a2/pages');
    fixture.detectChanges();
    await fixture.whenStable();
    await router.navigateByUrl('/o/o1/members');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(tab(el, 'Guides')?.getAttribute('href')).toBe('/o/o1/apps/a2/guides');
    expect(el.querySelector<HTMLSelectElement>('select[aria-label="Application"]')?.value).toBe('a2');
  });

  it('shows no app tabs for an organization without apps', async () => {
    TestBed.inject(AuthService).me.update((me) => ({
      ...me!,
      orgs: [{ ...me!.orgs[0], apps: [] }],
    }));
    const el = await at('/o/o1/members');
    expect(tab(el, 'Guides')).toBeUndefined();
    expect(tab(el, 'Members')).toBeDefined();
  });
});
