
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const files = await prisma.importedFile.findMany();
    console.log(JSON.stringify(files, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
