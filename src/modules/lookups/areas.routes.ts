import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { toDistrictCode } from "../../lib/districts.js";
import { prisma } from "../../lib/prisma.js";
import { routeDocs } from "../../openapi/docs.js";
import { sharedCache } from "../../plugins/cache.js";

const areaOptionSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
  })
  .meta({ id: "AreaOption" });

const areaDistrictSchema = z
  .object({
    code: z.string().nullable(),
    name: z.string(),
    areas: z.array(areaOptionSchema),
  })
  .meta({ id: "AreaDistrict" });

const areaDivisionSchema = z
  .object({
    name: z.string(),
    districts: z.array(areaDistrictSchema),
  })
  .meta({ id: "AreaDivision" });

const areaListSchema = z
  .object({ divisions: z.array(areaDivisionSchema) })
  .meta({ id: "AreaList" });

type AreaDistrict = z.infer<typeof areaDistrictSchema>;
type AreaDivision = z.infer<typeof areaDivisionSchema>;

const CACHE_SECONDS = 300;

export async function areaRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        ...routeDocs({
          tag: "Lookups",
          summary: "List areas",
          description:
            "Active areas grouped by division, then district. Divisions, districts and areas are each sorted by name. code is the district code that tutor-city checks compare against (null when the district name is not recognised). The same body for every caller. Cached for 5 minutes by shared caches; signed-in callers cache it in the browser only.",
          auth: "optional",
          signedInCache: `private, max-age=${CACHE_SECONDS}`,
          rateLimit: "120/min per IP",
        }),
        response: { 200: areaListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      sharedCache(request, reply, CACHE_SECONDS);
      const rows = await prisma.area.findMany({
        where: { isActive: true },
        select: { id: true, name: true, division: true, district: true },
        orderBy: [{ division: "asc" }, { district: "asc" }, { name: "asc" }],
      });

      // Rows arrive sorted by division, then district, so one pass can group them.
      const divisions: AreaDivision[] = [];
      let division: AreaDivision | undefined;
      let district: AreaDistrict | undefined;
      for (const row of rows) {
        if (division?.name !== row.division) {
          division = { name: row.division, districts: [] };
          divisions.push(division);
          district = undefined;
        }
        if (district?.name !== row.district) {
          district = { code: toDistrictCode(row.district), name: row.district, areas: [] };
          division.districts.push(district);
        }
        district?.areas.push({ id: row.id, name: row.name });
      }

      return { divisions };
    },
  );
}
