
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
    const files = await prisma.importedFile.findMany({
        orderBy: { importDate: 'desc' },
        take: 10
    });
    console.log(JSON.stringify(files, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
