import { Directive, ElementRef, Input, OnInit } from '@angular/core';

/**
 * Usage: <button [guideAnchor]="'invite-button'">Invite</button>
 * Sets a data-guide-id attribute that the core engine's target selectors
 * reference, e.g. targetSelector: '[data-guide-id="invite-button"]'.
 * This indirection is deliberate — it keeps guide targeting resilient to
 * CSS class/refactor churn (see scope doc, "selector fragility" risk).
 */
@Directive({
  selector: '[guideAnchor]',
  standalone: true,
})
export class GuideAnchorDirective implements OnInit {
  @Input('guideAnchor') guideId!: string;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngOnInit(): void {
    this.el.nativeElement.setAttribute('data-guide-id', this.guideId);
  }
}
