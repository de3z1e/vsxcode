const vscode = require('vscode');

function activate() {
    vscode.window.showInformationMessage(
        'Swift Package Helper has been renamed to VSXcode. You can uninstall this extension.',
        'Uninstall'
    ).then(choice => {
        if (choice === 'Uninstall') {
            vscode.commands.executeCommand(
                'workbench.extensions.uninstallExtension',
                'de3z1e.swift-package-helper'
            );
        }
    });
}

function deactivate() {}

module.exports = { activate, deactivate };
