import { z } from 'zod';

import { wholeNumberParam } from '../../fields';

// Ids are `int4` columns, so a larger value is refused here rather than failing the query.
export const INT4_MAX = 2147483647;

export const IdParamDto = wholeNumberParam(0, INT4_MAX);
export type IdParamDto = z.infer<typeof IdParamDto>;

export const PageParamDto = wholeNumberParam(1, INT4_MAX);
export type PageParamDto = z.infer<typeof PageParamDto>;
