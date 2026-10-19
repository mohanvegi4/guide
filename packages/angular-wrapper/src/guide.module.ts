import { NgModule } from '@angular/core';
import { GuideAnchorDirective } from './guide-anchor.directive';

@NgModule({
  imports: [GuideAnchorDirective], // standalone directive, re-exported for convenience
  exports: [GuideAnchorDirective],
})
export class GuideModule {}
