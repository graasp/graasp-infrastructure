import { DataAwsAvailabilityZones } from '@cdktf/provider-aws/lib/data-aws-availability-zones';
import { InternetGateway } from '@cdktf/provider-aws/lib/internet-gateway';
import { RouteTable } from '@cdktf/provider-aws/lib/route-table';
import { RouteTableAssociation } from '@cdktf/provider-aws/lib/route-table-association';
import { Subnet } from '@cdktf/provider-aws/lib/subnet';
import { Vpc as AwsVpc } from '@cdktf/provider-aws/lib/vpc';
import { Fn } from 'cdktf';

import { Construct } from 'constructs';

type VpcProps = {};

export class Vpc extends Construct {
  vpc: AwsVpc;
  subnets: Subnet[];
  igw: InternetGateway;
  routeTable: RouteTable;

  get publicSubnetsOutput() {
    return this.subnets.map((subnet) => subnet.id);
  }
  get azs() {
    return this.subnets.map((subnet) => subnet.availabilityZone);
  }
  get vpcIdOutput() {
    return this.vpc.id;
  }

  constructor(scope: Construct, id: string, _props: VpcProps) {
    super(scope, id);

    this.vpc = new AwsVpc(this, 'vpc', {
      cidrBlock: '172.32.0.0/16',
      enableDnsSupport: true,
      enableDnsHostnames: true,
      assignGeneratedIpv6CidrBlock: true,
    });

    const availabilityZones = new DataAwsAvailabilityZones(
      this,
      'availability-zones',
      {
        state: 'available',
      },
    );

    this.subnets = availabilityZones.names.slice(0, 3).map((azName, index) => {
      const subnet = new Subnet(this, `public-${azName}`, {
        vpcId: this.vpc.id,
        cidrBlock: Fn.cidrsubnet(this.vpc.cidrBlock, 8, index),
        ipv6CidrBlock: Fn.cidrsubnet(this.vpc.ipv6CidrBlock, 8, index),
        availabilityZone: azName,
        mapPublicIpOnLaunch: true,
        assignIpv6AddressOnCreation: true,
      });
      return subnet;
    });
    this.igw = new InternetGateway(this, 'igw', {
      vpcId: this.vpc.id,
    });
    this.routeTable = new RouteTable(this, 'route-table', {
      vpcId: this.vpc.id,
      route: [
        // ipv4 default route
        {
          cidrBlock: '0.0.0.0/0',
          gatewayId: this.igw.id,
        },
        // ipv6 default route
        {
          cidrBlock: '::/0',
          gatewayId: this.igw.id,
        },
      ],
    });
    this.subnets.forEach((subnet) => {
      new RouteTableAssociation(this, `route-table-association-${subnet.id}`, {
        subnetId: subnet.id,
        routeTableId: this.routeTable.id,
      });
    });
  }
}
