import type { DoctorReportItem } from '../core/types.js';

export const printDoctor = (report: DoctorReportItem[]) => {
  if (report.length === 0) {
    console.log('No variants found.');
    return;
  }
  for (const item of report) {
    console.log(`${item.ok ? '✓' : '✗'} ${item.name}`);
    if (!item.ok) {
      console.log(`  binary: ${item.binaryPath ?? 'missing'}`);
      console.log(`  wrapper: ${item.wrapperPath}`);
      if (item.issues && item.issues.length > 0) {
        for (const issue of item.issues) {
          console.log(`  issue: ${issue}`);
        }
      }
    }
  }
};
