import { Construct } from 'constructs';
import { Instance } from '@cdktf/provider-aws/lib/instance';
import { Vpc } from '../.gen/modules/vpc';
import { allowAllEgressRule } from './security_group';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { VpcSecurityGroupIngressRule } from '@cdktf/provider-aws/lib/vpc-security-group-ingress-rule';
import { TerraformVariable } from 'cdktf';
import { DataAwsSubnet } from '@cdktf/provider-aws/lib/data-aws-subnet';

export type S3BucketObjectOwnership = 'ObjectWriter' | 'BucketOwnerEnforced';

export class Ec2 extends Construct {
  ec2: Instance;
  securityGroup: SecurityGroup;

  constructor(
    scope: Construct,
    name: string,
    vpc: Vpc,
    gatekeeperKeyName: TerraformVariable,
    // amazon linux 2023 64bit x86
    ami = 'ami-0a485299eeb98b979'
  ) {
    super(scope, name);

    // todo: check this works + how to download a key pair from aws
    // const keyPair = new KeyPair(this, `${name}-key-pair`, {
    //   keyName: `${name}-key-pair`,
    //   publicKey: publicKey.value,
    // });

    // choose a random subnet in the given vpc
    const subnet = new DataAwsSubnet(this, 'ec2-subnet', {
      filter: [
        {
          name: `vpc-id`,
          values: [vpc.vpcIdOutput],
        },
      ],
    });

    this.ec2 = new Instance(this, `${name}-ec2`, {
      ami,
      instanceType: 't2.micro',
      keyName: gatekeeperKeyName.value,
      subnetId: subnet.id,
    });

    this.securityGroup = new SecurityGroup(scope, `${name}-security-group`, {
      vpcId: vpc.vpcIdOutput,
      name,
      lifecycle: {
        createBeforeDestroy: true, // see https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#recreating-a-security-group
      },
    });

    // allow ssh from anywhere
    // Do not use the `ingress` and `egress` directly on the SecurityGroup for limitations reasons
    // See note on https://registry.terraform.io/providers/hashicorp/aws/5.16.1/docs/resources/security_group#protocol
    new VpcSecurityGroupIngressRule(this, `allow-inbound-ssh`, {
      cidrIpv4: '0.0.0.0/0',
      fromPort: 22,
      ipProtocol: 'tcp',
      securityGroupId: this.securityGroup.id,
      toPort: 22,
    });

    // allow all egress
    allowAllEgressRule(scope, name, this.securityGroup.id);
  }
}
