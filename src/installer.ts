// Load tempDirectory before it gets wiped by tool-cache
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as hc from '@actions/http-client';
import {chmodSync} from 'fs';
import path from 'path';
import semver from 'semver';
import {IS_LINUX, IS_WINDOWS} from './utils';
import {QualityOptions} from './setup-dotnet';

export interface DotnetVersion {
  type: string;
  value: string;
  qualityFlag: boolean;
}

export class DotnetVersionResolver {
  private inputVersion: string;
  private resolvedArgument: DotnetVersion;

  constructor(version: string) {
    this.inputVersion = version.trim();
    this.resolvedArgument = {type: '', value: '', qualityFlag: false};
  }

  private async resolveVersionInput(): Promise<void> {
    if (!semver.validRange(this.inputVersion)) {
      throw new Error(
        `'dotnet-version' was supplied in invalid format: ${this.inputVersion}! Supported syntax: A.B.C, A.B, A.B.x, A, A.x`
      );
    }
    if (semver.valid(this.inputVersion)) {
      this.resolvedArgument.type = 'version';
      this.resolvedArgument.value = this.inputVersion;
    } else {
      const [major, minor] = this.inputVersion.split('.');

      if (this.isNumericTag(major)) {
        this.resolvedArgument.type = 'channel';
        if (this.isNumericTag(minor)) {
          this.resolvedArgument.value = `${major}.${minor}`;
        } else {
          const httpClient = new hc.HttpClient('actions/setup-dotnet', [], {
            allowRetries: true,
            maxRetries: 3
          });
          this.resolvedArgument.value = await this.getLatestVersion(
            httpClient,
            [major, minor]
          );
        }
      }
      this.resolvedArgument.qualityFlag = +major >= 6 ? true : false;
    }
  }

  private isNumericTag(versionTag): boolean {
    return /^\d+$/.test(versionTag);
  }

  public async createDotNetVersion(): Promise<{
    type: string;
    value: string;
    qualityFlag: boolean;
  }> {
    await this.resolveVersionInput();
    if (!this.resolvedArgument.type) {
      return this.resolvedArgument;
    }
    if (IS_WINDOWS) {
      this.resolvedArgument.type =
        this.resolvedArgument.type === 'channel' ? '-Channel' : '-Version';
    } else {
      this.resolvedArgument.type =
        this.resolvedArgument.type === 'channel' ? '--channel' : '--version';
    }
    return this.resolvedArgument;
  }

  private async getLatestVersion(
    httpClient: hc.HttpClient,
    versionParts: string[]
  ): Promise<string> {
    const response = await httpClient.getJson<any>(
      DotnetVersionResolver.DotNetCoreIndexUrl
    );
    const result = response.result || {};
    let releasesInfo: any[] = result['releases-index'];

    let releaseInfo = releasesInfo.find(info => {
      let sdkParts: string[] = info['channel-version'].split('.');
      return sdkParts[0] === versionParts[0];
    });

    if (!releaseInfo) {
      throw new Error(
        `Could not find info for version ${versionParts.join('.')} at ${
          DotnetVersionResolver.DotNetCoreIndexUrl
        }`
      );
    }

    return releaseInfo['channel-version'];
  }

  static DotNetCoreIndexUrl: string =
    'https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json';
}

export class DotnetCoreInstaller {
  private version: string;
  private quality: QualityOptions;
  private static readonly installationDirectoryWindows = path.join(
    process.env['PROGRAMFILES'] + '',
    'dotnet'
  );
  private static readonly installationDirectoryLinux = '/usr/share/dotnet';

  static addToPath() {
    if (process.env['DOTNET_INSTALL_DIR']) {
      core.addPath(process.env['DOTNET_INSTALL_DIR']);
      core.exportVariable('DOTNET_ROOT', process.env['DOTNET_INSTALL_DIR']);
    } else {
      if (IS_WINDOWS) {
        core.addPath(DotnetCoreInstaller.installationDirectoryWindows);
        core.exportVariable(
          'DOTNET_ROOT',
          DotnetCoreInstaller.installationDirectoryWindows
        );
      } else if (IS_LINUX) {
        core.addPath(DotnetCoreInstaller.installationDirectoryLinux);
        core.exportVariable(
          'DOTNET_ROOT',
          DotnetCoreInstaller.installationDirectoryLinux
        );
      } else {
        // This is the default set in install-dotnet.sh
        core.addPath(path.join(process.env['HOME'] + '', '.dotnet'));
        core.exportVariable(
          'DOTNET_ROOT',
          path.join(process.env['HOME'] + '', '.dotnet')
        );
      }
    }
  }

  constructor(version: string, quality: QualityOptions) {
    this.version = version;
    this.quality = quality;
  }

  private setQuality(
    dotnetVersion: DotnetVersion,
    scriptArguments: string[]
  ): void {
    const option = IS_WINDOWS ? '-Quality' : '--quality';
    if (dotnetVersion.qualityFlag) {
      scriptArguments.push(option, this.quality);
    } else {
      core.warning(
        `'dotnet-quality' input can be used only with .NET SDK version in A.B, A.B.x, A and A.x formats where the major tag is higher than 5. You specified: ${this.version}. 'dotnet-quality' input is ignored.`
      );
    }
  }

  public async installDotnet() {
    const windowsDefaultOptions = [
      '-NoLogo',
      '-Sta',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Unrestricted',
      '-Command'
    ];
    const scriptName = IS_WINDOWS ? 'install-dotnet.ps1' : 'install-dotnet.sh';
    const escapedScript = path
      .join(__dirname, '..', 'externals', scriptName)
      .replace(/'/g, "''");
    let scriptArguments: string[];
    let scriptPath = '';

    const versionResolver = new DotnetVersionResolver(this.version);
    const dotnetVersion = await versionResolver.createDotNetVersion();

    if (IS_WINDOWS) {
      scriptArguments = ['&', `'${escapedScript}'`];

      if (dotnetVersion.type) {
        scriptArguments.push(dotnetVersion.type, dotnetVersion.value);
      }

      if (this.quality) {
        this.setQuality(dotnetVersion, scriptArguments);
      }

      if (process.env['https_proxy'] != null) {
        scriptArguments.push(`-ProxyAddress ${process.env['https_proxy']}`);
      }
      // This is not currently an option
      if (process.env['no_proxy'] != null) {
        scriptArguments.push(`-ProxyBypassList ${process.env['no_proxy']}`);
      }

      scriptArguments.push(
        `-InstallDir '${DotnetCoreInstaller.installationDirectoryWindows}'`
      );
      // process.env must be explicitly passed in for DOTNET_INSTALL_DIR to be used
      scriptPath =
        (await io.which('pwsh', false)) || (await io.which('powershell', true));
      scriptArguments = [...windowsDefaultOptions, scriptArguments.join(' ')];
    } else {
      chmodSync(escapedScript, '777');
      scriptPath = await io.which(escapedScript, true);
      scriptArguments = [];

      if (dotnetVersion.type) {
        scriptArguments.push(dotnetVersion.type, dotnetVersion.value);
      }

      if (this.quality) {
        this.setQuality(dotnetVersion, scriptArguments);
      }

      if (IS_LINUX) {
        scriptArguments.push(
          '--install-dir',
          DotnetCoreInstaller.installationDirectoryLinux
        );
      }
    }
    const {exitCode, stdout} = await exec.getExecOutput(
      `"${scriptPath}"`,
      scriptArguments,
      {ignoreReturnCode: true}
    );
    if (exitCode) {
      throw new Error(`Failed to install dotnet ${exitCode}. ${stdout}`);
    }
  }
}
