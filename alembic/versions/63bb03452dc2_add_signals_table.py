"""add signals table

Revision ID: 63bb03452dc2
Revises: 8f2b1c4d9a07
Create Date: 2026-08-12 23:36:27.108646

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '63bb03452dc2'
down_revision: Union[str, Sequence[str], None] = '8f2b1c4d9a07'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Autogenerate also offered to rename the index on voices.user_id from
    ix_classes_user_id, left behind by the classes -> voices rename. It is not
    part of this change and is deliberately left out: on SQLite an index rename
    goes through batch_alter_table, which copies the whole table and renames it
    back, and a table rebuild does not belong in a migration that adds one.
    """
    op.create_table('signals',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=True),
    sa.Column('clerk_user_id', sa.String(), nullable=True),
    sa.Column('created_at', sa.DateTime(), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_signals_user_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_signals'))
    )
    with op.batch_alter_table('signals', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_signals_created_at'), ['created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_signals_kind'), ['kind'], unique=False)
        batch_op.create_index(batch_op.f('ix_signals_user_id'), ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('signals', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_signals_user_id'))
        batch_op.drop_index(batch_op.f('ix_signals_kind'))
        batch_op.drop_index(batch_op.f('ix_signals_created_at'))

    op.drop_table('signals')
    # ### end Alembic commands ###
