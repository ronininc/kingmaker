// Kingmaker's office bundle leaves out unzipper (it pulls in `buffers`, which carries no licence). Only exceljs's
// streaming WorkbookReader used it; workbook.xlsx.load(buffer) and every writer work without it.
const no = () => { throw new Error('Streaming xlsx reading is not in Kingmaker; use workbook.xlsx.load(buffer).'); };
module.exports = { Parse: no, Open: { buffer: no, file: no }, ParseOne: no, Extract: no };
