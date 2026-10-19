import { Router } from 'express';
import { requireStudioUser } from '../../auth/studio';
import { orgsRouter } from './orgs';
import { membersRouter } from './members';
import { guidesRouter } from './guides';
import { pagesRouter } from './pages';
import { analyticsRouter } from './analytics';
import { errorsRouter } from './errors';
import { platformRouter } from './platform';

/**
 * Studio API (/v1/...). Every route needs a verified Studio user; what they
 * can reach is resolved from their org/app memberships on each request.
 */
export const studioRouter = Router();
studioRouter.use(requireStudioUser);
studioRouter.use(orgsRouter);
studioRouter.use(membersRouter);
studioRouter.use('/apps/:appId/guides', guidesRouter);
studioRouter.use('/apps/:appId/pages', pagesRouter);
studioRouter.use(analyticsRouter);
studioRouter.use('/apps/:appId/errors', errorsRouter);
studioRouter.use('/platform', platformRouter);
