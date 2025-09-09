import { connection, payer } from '../src/util';
import { createFlashLoanVault } from 'jito-ts';

createFlashLoanVault(connection, payer).then((sig) =>
  console.log('Vault created:', sig),
);
