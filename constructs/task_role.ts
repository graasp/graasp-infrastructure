import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { IamRolePolicy } from '@cdktf/provider-aws/lib/iam-role-policy';
import { Fn, Token } from 'cdktf';

import { Construct } from 'constructs';

export class TaskRole extends Construct {
  name: string;
  role: IamRole;

  constructor(scope: Construct, name: string) {
    super(scope, name);

    this.name = name;

    this.role = new IamRole(this, `${name}-task-role`, {
      name: `${name}-task-role`,
      // this role shall only be used by an ECS task
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Sid: '',
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
          },
        ],
      }),
    });
  }

  allowECSExec() {
    const policyName = `${this.name}-allow-ecsExec-policy`;
    new IamRolePolicy(this, policyName, {
      name: policyName,
      role: this.role.id,
      policy: Token.asString(
        Fn.jsonencode({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: [
                'ssmmessages:CreateControlChannel',
                'ssmmessages:CreateDataChannel',
                'ssmmessages:OpenControlChannel',
                'ssmmessages:OpenDataChannel',
              ],
              Resource: '*',
            },
          ],
        }),
      ),
    });
    return this;
  }

  allowS3Access(
    bucket_arn: string,
    { read, write }: { read: boolean; write?: boolean },
  ) {
    const policyName = `${this.name}-allow-s3-bucket-policy`;
    new IamRolePolicy(this, policyName, {
      name: policyName,
      role: this.role.id,
      policy: Token.asString(
        Fn.jsonencode({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: [
                ...(read ? ['s3:GetObject', 's3:ListBucket'] : []),
                ...(write ? ['s3:PutObject'] : []),
              ],
              Resource: bucket_arn,
            },
          ],
        }),
      ),
    });
    return this;
  }
}
