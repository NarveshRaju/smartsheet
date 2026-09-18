import { prisma } from './services/db.js';
import { fullSync } from './services/sync.service.js';
import { logger } from './utils/logger.js';

// Run outside the web server: no browser session or live Render process is required.
try {
  const configs = await prisma.syncConfiguration.findMany({ where: { isEnabled: true } });
  for (const config of configs) {
    try {
      const result = await fullSync(config.id);
      logger.info(`Scheduled sync ${config.id}: ${JSON.stringify(result)}`);
      if (result.failed) process.exitCode = 1;
    } catch (error: any) {
      if (error.statusCode !== 409) {
        logger.error(`Scheduled sync failed: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
} finally {
  await prisma.$disconnect();
}
