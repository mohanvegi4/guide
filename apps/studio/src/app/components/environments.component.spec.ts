import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EnvironmentsComponent } from './environments.component';
import { Environment } from '../core/models';

const test: Environment = {
  id: 'e1',
  name: 'Test',
  position: 1,
  websites: ['https://test.oclc.test'],
  analyticsEnabled: false,
};
const prod: Environment = {
  id: 'e2',
  name: 'Production',
  position: 2,
  websites: ['https://oclc.test'],
  analyticsEnabled: true,
};

describe('EnvironmentsComponent', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<EnvironmentsComponent>;

  async function render(canDelete = true) {
    TestBed.configureTestingModule({
      imports: [EnvironmentsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(EnvironmentsComponent);
    fixture.componentRef.setInput('appId', 'a1');
    fixture.componentRef.setInput('canDelete', canDelete);
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/environments').flush([test, prod]);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const click = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
      .click();

  afterEach(() => http.verify());

  it('lists the stages in order, marks production, and saves websites and the analytics switch', async () => {
    const el = await render();
    expect(el.querySelector('[data-testid="environment-Production"]')!.textContent).toContain(
      'production',
    );
    const box = el.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Websites of Test, one per line"]',
    )!;
    expect(box.value).toBe('https://test.oclc.test');
    box.value = 'https://test.oclc.test/some/path\nhttps://qa.oclc.test';
    box.dispatchEvent(new Event('input'));
    click(el, 'Save Test');
    const req = http.expectOne('/api/v1/apps/a1/environments/e1');
    expect(req.request.body).toEqual({
      name: 'Test',
      websites: ['https://test.oclc.test', 'https://qa.oclc.test'],
      analyticsEnabled: false,
    });
    req.flush(test);
    http.expectOne('/api/v1/apps/a1/environments').flush([test, prod]);
  });

  it('adds a stage, reorders (asking when production changes), and deletes with the typed name', async () => {
    const el = await render();
    const name = el.querySelector<HTMLInputElement>('input[name="newName"]')!;
    name.value = 'Accept';
    name.dispatchEvent(new Event('input'));
    const sites = el.querySelector<HTMLInputElement>('input[name="newWebsites"]')!;
    sites.value = 'https://accept.oclc.test';
    sites.dispatchEvent(new Event('input'));
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    const created = http.expectOne(
      (r) => r.method === 'POST' && r.url === '/api/v1/apps/a1/environments',
    );
    expect(created.request.body).toEqual({
      name: 'Accept',
      websites: ['https://accept.oclc.test'],
      last: false,
    });
    created.flush({ ...test, id: 'e3', name: 'Accept' });
    http.expectOne('/api/v1/apps/a1/environments').flush([test, prod]);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    click(el, 'Move Test later');
    expect(confirm).toHaveBeenCalled();
    http.expectNone('/api/v1/apps/a1/environments/order');

    vi.spyOn(window, 'prompt').mockReturnValue('Test');
    click(el, 'Delete Test');
    const del = http.expectOne('/api/v1/apps/a1/environments/e1');
    expect(del.request.method).toBe('DELETE');
    expect(del.request.body).toEqual({ confirmName: 'Test' });
    del.flush(null);
    http.expectOne('/api/v1/apps/a1/environments').flush([prod]);
  });

  it('adds a new production at the end, after asking, when the switch is on', async () => {
    const el = await render();
    const name = el.querySelector<HTMLInputElement>('input[name="newName"]')!;
    name.value = 'Live';
    name.dispatchEvent(new Event('input'));
    const toggle = el.querySelector<HTMLInputElement>('input[name="newIsProduction"]')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    const form = el.querySelector('form')!;

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    form.dispatchEvent(new Event('submit'));
    expect(confirm).toHaveBeenCalled();
    http.expectNone((r) => r.method === 'POST');

    confirm.mockReturnValue(true);
    form.dispatchEvent(new Event('submit'));
    const created = http.expectOne((r) => r.method === 'POST');
    expect(created.request.body).toEqual({ name: 'Live', websites: [], last: true });
    const live: Environment = { ...prod, id: 'e3', name: 'Live', position: 3, websites: [] };
    created.flush(live);
    http.expectOne('/api/v1/apps/a1/environments').flush([test, prod, live]);
    await fixture.whenStable();
    expect(el.textContent).toContain('Added Live as production.');
    expect(toggle.checked).toBe(false);
    expect(el.querySelector('[data-testid="environment-Production"]')!.textContent).not.toContain(
      'production',
    );
    expect(el.querySelector('[data-testid="environment-Live"]')!.textContent).toContain('production');
  });

  it('marks a single environment as production too', async () => {
    TestBed.configureTestingModule({
      imports: [EnvironmentsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(EnvironmentsComponent);
    fixture.componentRef.setInput('appId', 'a1');
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/apps/a1/environments').flush([prod]);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="environment-Production"] .badge')!.textContent).toBe(
      'production',
    );
  });

  it('offers no Delete without the manager role', async () => {
    const el = await render(false);
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Delete')).toBe(
      false,
    );
  });
});
