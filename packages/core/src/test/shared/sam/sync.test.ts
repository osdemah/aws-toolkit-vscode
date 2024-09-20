/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import assert from 'assert'
import { ParamsSource, prepareSyncParams, SyncParams, SyncWizard } from '../../../shared/sam/sync'
import {
    createBaseImageTemplate,
    createBaseTemplate,
    makeSampleSamTemplateYaml,
} from '../cloudformation/cloudformationTestUtils'
import { createWizardTester } from '../wizards/wizardTestUtils'
import { AWSTreeNodeBase } from '../../../shared/treeview/nodes/awsTreeNodeBase'
import { makeTemporaryToolkitFolder } from '../../../shared/filesystemUtilities'
import { ToolkitError } from '../../../shared/errors'
import globals from '../../../shared/extensionGlobals'
import fs from '../../../shared/fs/fs'

describe('SyncWizard', async function () {
    const createTester = async (params?: Partial<SyncParams>) =>
        createWizardTester(new SyncWizard({ deployType: 'code', ...params }, await globals.templateRegistry))

    it('shows steps in correct order', async function () {
        const tester = await createTester()
        tester.projectRoot.assertShowFirst()
        tester.paramsSource.assertShowSecond()

        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file('/')
        const rootFolderUri = vscode.Uri.joinPath(workspaceUri, 'my')
        const tester2 = await createTester({
            paramsSource: ParamsSource.SpecifyAndSave,
            projectRoot: rootFolderUri,
        })
        tester2.template.assertShowFirst()
        tester2.region.assertShowSecond()
        tester2.stackName.assertShowThird()
        tester2.bucketName.assertShow(4)
    })

    it('skips prompts if user chooses samconfig file as params source', async function () {
        const tester = await createTester({ paramsSource: ParamsSource.SamConfig })
        tester.template.assertDoesNotShow()
        tester.region.assertDoesNotShow()
        tester.stackName.assertDoesNotShow()
        tester.bucketName.assertDoesNotShow()
    })

    it('prompts for ECR repo if template has image-based resource', async function () {
        const template = { uri: vscode.Uri.file('/'), data: createBaseImageTemplate() }
        const tester = await createTester({ template })
        tester.ecrRepoUri.assertShow()
    })

    it('skips prompt for ECR repo if template has no image-based resources', async function () {
        const template = { uri: vscode.Uri.file('/'), data: createBaseTemplate() }
        const tester = await createTester({ template })
        tester.ecrRepoUri.assertDoesNotShow()
    })

    it("uses the template's workspace subfolder as the project root is not set", async function () {
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri
        assert.ok(workspaceUri)
        const rootFolderUri = vscode.Uri.joinPath(workspaceUri, 'my')
        assert.ok(rootFolderUri)

        const templateUri = vscode.Uri.joinPath(rootFolderUri, 'template.yaml')
        const template = { uri: templateUri, data: createBaseTemplate() }
        const tester = await createTester({ template, projectRoot: rootFolderUri })
        tester.projectRoot.path.assertValue(rootFolderUri.path)
    })
})

describe('prepareSyncParams', function () {
    let tempDir: vscode.Uri

    beforeEach(async function () {
        tempDir = vscode.Uri.file(await makeTemporaryToolkitFolder())
    })

    afterEach(async function () {
        await fs.delete(tempDir, { recursive: true })
    })

    it('uses region if given a tree node', async function () {
        const params = await prepareSyncParams(
            new (class extends AWSTreeNodeBase {
                public override readonly regionCode = 'foo'
            })('')
        )

        assert.strictEqual(params.region, 'foo')
    })

    async function makeTemplateItem(dir: vscode.Uri) {
        const uri = vscode.Uri.joinPath(dir, 'template.yaml')
        const data = makeSampleSamTemplateYaml(true)
        await fs.writeFile(uri, JSON.stringify(data))

        return { uri, data }
    }

    it('loads template if given a URI', async function () {
        const template = await makeTemplateItem(tempDir)

        const params = await prepareSyncParams(template.uri)
        assert.strictEqual(params.template?.uri.fsPath, template.uri.fsPath)
        assert.deepStrictEqual(params.template?.data, template.data)
    })

    it('skips dependency layers by default', async function () {
        const template = await makeTemplateItem(tempDir)

        const params = await prepareSyncParams(template.uri)
        assert.strictEqual(params.skipDependencyLayer, true)
    })

    describe('samconfig.toml', function () {
        async function makeDefaultConfig(dir: vscode.Uri, body: string) {
            const uri = vscode.Uri.joinPath(dir, 'samconfig.toml')
            const data = `
            [default.sync.parameters]
            ${body}
`
            await fs.writeFile(uri, data)

            return uri
        }

        async function getParams(body: string, dir = tempDir) {
            const config = await makeDefaultConfig(dir, body)

            return prepareSyncParams(config)
        }

        it('throws on non-string values', async function () {
            await assert.rejects(() => getParams(`region = 0`), ToolkitError)
        })

        it('does not fail on missing values', async function () {
            const params = await getParams(`region = "bar"`)
            assert.strictEqual(params.region, 'bar')
        })

        it('sets the project root as the parent directory', async function () {
            const params = await getParams(`region = "bar"`, tempDir)
            assert.strictEqual(params.projectRoot?.fsPath, tempDir.fsPath)
        })

        it('uses the depdency layer option if provided', async function () {
            const params = await getParams(`dependency_layer = true`, tempDir)
            assert.strictEqual(params.skipDependencyLayer, false)
        })

        it('can load a relative template param', async function () {
            const template = await makeTemplateItem(tempDir)
            const params = await getParams(`template = "./template.yaml"`)
            assert.deepStrictEqual(params.template?.data, template.data)
        })

        it('can load an absolute template param', async function () {
            const template = await makeTemplateItem(tempDir)
            const params = await getParams(`template = '${template.uri.fsPath}'`)
            assert.deepStrictEqual(params.template?.data, template.data)
        })

        it('can load a relative template param without a path seperator', async function () {
            const template = await makeTemplateItem(tempDir)
            const params = await getParams(`template = "template.yaml"`)
            assert.deepStrictEqual(params.template?.data, template.data)
        })

        it('can load a template param using an alternate key', async function () {
            const template = await makeTemplateItem(tempDir)
            const params = await getParams(`template_file = "template.yaml"`)
            assert.deepStrictEqual(params.template?.data, template.data)
        })

        it('can use global params', async function () {
            const params = await getParams(`
            region = "bar"
            [default.global.parameters]
            stack_name = "my-app"
            `)
            assert.strictEqual(params.stackName, 'my-app')
        })

        it('prefers using the sync section over globals', async function () {
            const params = await getParams(`
            stack_name = "my-sync-app"
            [default.global.parameters]
            stack_name = "my-app"
            `)
            assert.strictEqual(params.stackName, 'my-sync-app')
        })

        it('loads all values if found', async function () {
            const params = await getParams(`
            region = "bar"
            stack_name = "my-app"
            s3_bucket = "my-bucket"
            image_repository = "12345679010.dkr.ecr.bar.amazonaws.com/repo"
            `)
            assert.strictEqual(params.region, 'bar')
            assert.strictEqual(params.stackName, 'my-app')
            assert.strictEqual(params.bucketName, 'my-bucket')
            assert.strictEqual(params.ecrRepoUri, '12345679010.dkr.ecr.bar.amazonaws.com/repo')
        })
    })
})
