import {Command, flags} from '@oclif/command'
import fs from 'fs-extra';
import path from 'path';
import getConfig from "./util/getConfig";
import execa from "execa";
import {downloadUrl} from "./util/downloadUrl";
import Listr from "listr";

interface Flags {
  ignoreLocal: boolean;
  location?: string;
}

interface Args {
  repo: string;
}


class Repro extends Command {
  static description = 'describe the command here'

  static flags = {
    version:     flags.version({char: 'v'}),
    help:        flags.help({char: 'h'}),
    ignoreLocal: flags.boolean({char: 'i', description: 'If set, will ignore any local configs in ~/.config/repro/'}),
    location:    flags.string({
      char:        'l',
      description: 'Location to clone the repro to. Will clone the same way git does, if not specified.'
    }),
  }

  static args = [{name: 'repo', description: 'Repository to create a reproduction for', required: true}]

  async run() {
    const {args, flags} = this.parse<Flags, Args>(Repro);
    const repo          = args.repo.split('@');
    const version       = repo[1] || 'latest';
    const dirName       = repo[0].split('/');
    if (dirName[1] === undefined) {
      return this.error('Invalid repo passed. Must be in the <OWNER>/<REPO> format.')
    }

    const dir = path.join(process.cwd(), flags.location || dirName[1]);
    if (fs.existsSync(dir)) {
      return this.error(
        'Directory already exists where we are trying to create the reproduction: ' +
        dir
      );
    }

    const config = await getConfig(repo[0], version);
    if (!config) {
      return this.error('Failed to find any repro configs for ' + repo);
    }

    try {
      await fs.mkdirp(dir);
      const tasks = new Listr([
        {
          title: 'Preparing Dependencies',
          task:  () => new Listr([
            {
              title: 'Copying package.json',
              task:  () => fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(config.package, null, 4))
            },
            {
              title: 'Install package dependencies with Yarn',
              task:  (ctx, task) => execa('yarn', [], {cwd: dir})
                .catch(() => {
                  ctx.yarn = false;

                  task.skip('Yarn not available, install it via `npm install -g yarn`');
                })
            },
            {
              title:   'NPM Installing',
              enabled: ctx => ctx.yarn === false,
              task:    () => execa('npm', ['install'], {cwd: dir})
            },
          ]),
        },
        {
          title: 'Creating Files',
          task:  () => new Listr(config.files.map((file) => (
            {
              title: file.path,
              task:  async () => {
                let content = file.content;
                if (!content) {
                  if (file.localUrl) {
                    const vrs = version === 'latest' ? 'master' : version;
                    file.url = `https://raw.githubusercontent.com/${repo}/${vrs}/${file.localUrl.replace(/^\.\//, '')}`;
                  }

                  content = await downloadUrl(file.url!);

                  if (content.startsWith('404: Not Found')) {
                    throw new Error('File not found: ' + JSON.stringify(file));
                  }
                }

                await fs.outputFile(path.join(dir, file.path), content)
                await fs.chmod(path.join(dir, file.path), file.permissions || 0o700);
              }
            }
          )))
        }
      ], {concurrent: true})

      await tasks.run();

      this.log('Finished creating reproduction!');
    } catch (e) {
      await fs.remove(dir);
      this.log(e);
      this.error('Failed to create reproduction. Cleaning up');
    }
  }
}

export = Repro