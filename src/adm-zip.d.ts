declare module "adm-zip" {
  export default class AdmZip {
    constructor(data?: Buffer | string);
    addFile(entryName: string, data: Buffer): void;
    deleteFile(entryName: string): void;
    writeZip(targetPath: string): void;
  }
}
