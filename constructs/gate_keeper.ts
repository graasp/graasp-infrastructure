import { TerraformVariable } from 'cdktf';

import { Construct } from 'constructs';

import { Vpc } from '../.gen/modules/vpc';
import { Ec2 } from './ec2';

export class GateKeeper extends Construct {
  public instance: Ec2;

  constructor(scope: Construct, name: string, vpc: Vpc) {
    super(scope, `${name}-gatekeeper`);

    const gatekeeperKeyName = new TerraformVariable(
      scope,
      'GRAASP_DB_GATEKEEPER_KEY_NAME',
      {
        nullable: false,
        type: 'string',
        description: 'Keyname for the keypair for graasp db gatekeeper',
        sensitive: true,
      },
    );
    const gatekeeperAmiId = new TerraformVariable(
      scope,
      'DB_GATEKEEPER_AMI_ID',
      {
        nullable: false,
        type: 'string',
        description: 'AMI id for graasp db gatekeeper',
        sensitive: false,
      },
    );

    const gatekeeperInstanceType = new TerraformVariable(
      scope,
      'DB_GATEKEEPER_INSTANCE_TYPE',
      {
        nullable: false,
        type: 'string',
        description: 'AMI instance type for graasp db gatekeeper',
        sensitive: false,
      },
    );

    this.instance = new Ec2(
      this,
      `${name}-gatekeeper`,
      vpc,
      gatekeeperKeyName,
      gatekeeperAmiId.value,
      gatekeeperInstanceType.value,
      true,
    );
  }
}
